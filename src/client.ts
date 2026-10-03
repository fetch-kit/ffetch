import type {
  FFetchOptions,
  FFetch,
  FFetchRequestInit,
  PendingRequest,
} from './types.js'
import { retry, defaultDelay } from './retry.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import {
  type PluginDispatch,
  type PluginRequestContext,
  type PluginExtensions,
  type PluginRequestPromiseExtensions,
  type ClientPlugin,
  type PluginExtensionBase,
  type PluginRequestPromiseExtensionBase,
} from './plugins.js'
import {
  TimeoutError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from './error.js'

/**
 * Body values that ffetch owns in memory, so reading one before the first
 * attempt cannot stall an upload that is still in flight.
 */
function isOwnedBody(body: FFetchRequestInit['body']): boolean {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData
  )
}

/**
 * Whether the body can be copied before the first attempt so that a retry can
 * send it again. Only a body ffetch owns is safe to copy: a `ReadableStream`
 * needs `duplex: 'half'`, and a `Request` input or a request returned by a
 * `transformRequest` hook can carry an upload that only ends when the server
 * acknowledges it, so buffering one would stall the first attempt. Those
 * requests keep the previous behaviour instead and skip the body on a retry.
 */
function canReplayBody(
  input: RequestInfo | URL,
  init: FFetchRequestInit,
  hasTransformRequest: boolean
): boolean {
  if (hasTransformRequest) return false
  if (input instanceof Request) return false
  return isOwnedBody(init.body)
}

/**
 * Reads the request body so that a retry can send it again. Sending a request
 * consumes its body, so the copy has to be taken before the first attempt, and
 * reading a clone leaves the original request untouched. Each attempt then gets
 * an independent body instead of a clone of the already-sent request, which
 * fails with "unusable".
 *
 * Only called for a body ffetch owns, which is why the request always has one.
 */
async function captureReplayableBody(
  request: Request
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer())
  } catch {
    // The body is already consumed, for example by a hook: keep the previous
    // behaviour rather than failing here.
    return null
  }
}

/**
 * HTTP statuses that `throwOnHttpError` turns into an `HttpError`.
 */
function isHttpErrorStatus(status: number): boolean {
  return (
    (status >= 400 && status < 500 && status !== 429) ||
    status >= 500 ||
    status === 429
  )
}

export function createClient<
  TPlugins extends readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[] = readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[],
>(
  opts: FFetchOptions<TPlugins> = {} as FFetchOptions<TPlugins>
): FFetch<
  PluginExtensions<TPlugins>,
  PluginRequestPromiseExtensions<TPlugins>
> {
  const {
    timeout: clientDefaultTimeout = 5_000,
    retries: clientDefaultRetries = 0,
    retryDelay: clientDefaultRetryDelay = defaultDelay,
    shouldRetry: clientDefaultShouldRetry = defaultShouldRetry,
    hooks: clientDefaultHooks = {},
    fetchHandler,
    plugins: inputPlugins = [] as unknown as TPlugins,
  } = opts

  const extensionDescriptors: PropertyDescriptorMap = Object.create(null)

  const plugins = inputPlugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => {
      const aOrder = a.plugin.order ?? 0
      const bOrder = b.plugin.order ?? 0
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.index - b.index
    })
    .map((entry) => entry.plugin)

  for (const plugin of plugins) {
    plugin.setup?.({
      defineExtension: (key, descriptor) => {
        const propertyKey = key as PropertyKey
        if (propertyKey in extensionDescriptors) {
          throw new Error(
            `Plugin extension collision for property "${String(propertyKey)}"`
          )
        }
        if ('get' in descriptor) {
          extensionDescriptors[propertyKey] = {
            get: descriptor.get,
            enumerable: descriptor.enumerable ?? true,
            configurable: false,
          }
          return
        }
        extensionDescriptors[propertyKey] = {
          value: descriptor.value,
          writable: false,
          enumerable: descriptor.enumerable ?? true,
          configurable: false,
        }
      },
    })
  }

  const pendingRequests: PendingRequest[] = []

  // Helper to abort all pending requests
  function abortAll() {
    for (const entry of pendingRequests) {
      entry.controller?.abort()
    }
  }

  const client = (input: RequestInfo | URL, init: FFetchRequestInit = {}) => {
    const execute = async () => {
      let request = new Request(input, init)

      // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
      const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
      if (effectiveHooks.transformRequest) {
        request = await effectiveHooks.transformRequest(request)
      }
      await effectiveHooks.before?.(request)

      // Determine retry config (per-request overrides client default)
      const effectiveRetries = init.retries ?? clientDefaultRetries
      const effectiveRetryDelay =
        typeof init.retryDelay !== 'undefined'
          ? init.retryDelay
          : clientDefaultRetryDelay
      const effectiveShouldRetry = init.shouldRetry ?? clientDefaultShouldRetry

      // Only a request that can be retried needs a re-sendable body, and only a
      // body ffetch owns can be copied without stalling an upload.
      const replayableBody =
        effectiveRetries > 0 &&
        canReplayBody(
          input,
          init,
          effectiveHooks.transformRequest !== undefined
        )
          ? await captureReplayableBody(request)
          : null

      // AbortSignal.timeout/any logic
      const effectiveTimeout = init.timeout ?? clientDefaultTimeout
      const userSignal = init.signal
      const transformedSignal = request.signal

      const pluginContext: PluginRequestContext = {
        request,
        init,
        state: Object.create(null),
        metadata: {
          startedAt: Date.now(),
          timeoutMs: effectiveTimeout,
          signals: {
            user:
              userSignal === undefined || userSignal === null
                ? undefined
                : userSignal,
            transformed: transformedSignal,
          },
          retry: {
            configuredRetries: effectiveRetries,
            configuredDelay: effectiveRetryDelay,
            attempt: 0,
          },
        },
      }

      for (const plugin of plugins) {
        await plugin.preRequest?.(pluginContext)
      }

      // Determine throwOnHttpError (per-request overrides client default)
      const effectiveThrowOnHttpError =
        typeof init.throwOnHttpError !== 'undefined'
          ? init.throwOnHttpError
          : (opts.throwOnHttpError ?? false)

      // Create timeout signal (manual implementation if AbortSignal.timeout not available)
      function createTimeoutSignal(timeout: number): AbortSignal {
        if (typeof AbortSignal?.timeout === 'function') {
          return AbortSignal.timeout(timeout)
        }
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        controller.signal.addEventListener(
          'abort',
          () => clearTimeout(timeoutId),
          { once: true }
        )
        return controller.signal
      }

      let timeoutSignal: AbortSignal | undefined = undefined
      let combinedSignal: AbortSignal | undefined = undefined
      const controller = new AbortController()

      if (effectiveTimeout > 0) {
        timeoutSignal = createTimeoutSignal(effectiveTimeout)
        pluginContext.metadata.signals.timeout = timeoutSignal
      }

      const signals: AbortSignal[] = []
      if (userSignal) signals.push(userSignal)
      if (transformedSignal && transformedSignal !== userSignal) {
        signals.push(transformedSignal)
      }
      if (timeoutSignal) signals.push(timeoutSignal)
      signals.push(controller.signal)

      if (signals.length === 1) {
        combinedSignal = signals[0]
      } else {
        if (typeof AbortSignal.any !== 'function') {
          throw new Error(
            'AbortSignal.any is required for combining multiple signals. Please install a polyfill for environments that do not support it.'
          )
        }
        combinedSignal = AbortSignal.any(signals)
      }
      pluginContext.metadata.signals.combined = combinedSignal

      let coreErrorReported = false
      const reportCoreError = async (error: unknown, hookRequest: Request) => {
        if (coreErrorReported) return
        if (
          !(error instanceof TimeoutError) &&
          !(error instanceof AbortError) &&
          !(error instanceof NetworkError) &&
          !(error instanceof RetryLimitError)
        ) {
          return
        }

        coreErrorReported = true
        if (error instanceof TimeoutError) {
          await effectiveHooks.onTimeout?.(hookRequest)
        } else if (error instanceof AbortError) {
          await effectiveHooks.onAbort?.(hookRequest)
        }
        await effectiveHooks.onError?.(hookRequest, error)
      }

      const retryWithHooks = async (
        dispatchCtx: PluginRequestContext,
        dispatchSignal: AbortSignal | undefined
      ) => {
        const requestForAttempt = dispatchCtx.request
        // A plugin can replace the request, in which case the copy no longer
        // matches it and each attempt falls back to cloning.
        const attemptBody =
          dispatchCtx.request === request ? replayableBody : null
        let attempt = 0
        const shouldRetryWithHook = async (
          ctx: import('./types').RetryContext
        ) => {
          attempt = ctx.attempt
          dispatchCtx.metadata.retry.attempt = attempt
          dispatchCtx.metadata.retry.lastError = ctx.error
          dispatchCtx.metadata.retry.lastResponse = ctx.response
          const retrying = effectiveShouldRetry(ctx)
          dispatchCtx.metadata.retry.shouldRetryResult = retrying
          if (retrying && attempt <= effectiveRetries) {
            await effectiveHooks.onRetry?.(
              requestForAttempt,
              attempt - 1,
              ctx.error,
              ctx.response
            )
          }
          if (retrying) {
            const body = ctx.response?.body
            if (body) {
              void body.cancel().catch(() => {})
            }
          }
          return retrying
        }

        let res: Response
        try {
          res = await retry(
            async (attempt) => {
              if (controller.signal.aborted) {
                throw new AbortError('Request was aborted')
              }
              if (userSignal?.aborted) {
                throw new AbortError('Request was aborted by user')
              }
              if (timeoutSignal?.aborted) {
                throw new TimeoutError('signal timed out')
              }
              if (dispatchSignal?.aborted) {
                if (userSignal?.aborted) {
                  throw new AbortError('Request was aborted by user')
                } else if (timeoutSignal?.aborted) {
                  throw new TimeoutError('signal timed out')
                } else {
                  throw new AbortError(
                    'Request was aborted',
                    dispatchSignal.reason
                  )
                }
              }
              for (const plugin of plugins) {
                await plugin.beforeAttempt?.(dispatchCtx, attempt)
              }
              const reqWithSignal =
                attemptBody === null
                  ? new Request(requestForAttempt.clone(), {
                      signal: dispatchSignal,
                    })
                  : new Request(requestForAttempt, {
                      signal: dispatchSignal,
                      body: attemptBody.slice(),
                    })
              try {
                const handler = init.fetchHandler ?? fetchHandler ?? fetch
                const response = await handler(reqWithSignal)
                dispatchCtx.metadata.retry.lastResponse = response
                return response
              } catch (err) {
                dispatchCtx.metadata.retry.lastError = err
                if (err instanceof DOMException && err.name === 'AbortError') {
                  if (
                    timeoutSignal?.aborted &&
                    (!userSignal || !userSignal.aborted)
                  ) {
                    throw new TimeoutError('signal timed out', err)
                  } else if (userSignal?.aborted) {
                    throw new AbortError('Request was aborted by user')
                  } else if (controller.signal.aborted) {
                    throw new AbortError('Request was aborted', err)
                  } else {
                    throw new AbortError(
                      'Request was aborted',
                      new DOMException('Aborted', 'AbortError')
                    )
                  }
                } else if (
                  err instanceof TypeError &&
                  /NetworkError|network error|failed to fetch|lost connection|NetworkError when attempting to fetch resource/i.test(
                    err.message
                  )
                ) {
                  throw new NetworkError(err.message, err)
                }
                throw err
              }
            },
            effectiveRetries,
            effectiveRetryDelay,
            shouldRetryWithHook,
            requestForAttempt,
            dispatchSignal
          )
        } catch (err: unknown) {
          dispatchCtx.metadata.retry.lastError = err
          if (err instanceof TimeoutError) {
            if (dispatchCtx === pluginContext) {
              await reportCoreError(err, requestForAttempt)
            }
            throw err
          }
          if (err instanceof AbortError) {
            if (dispatchCtx === pluginContext) {
              await reportCoreError(err, requestForAttempt)
            }
            throw err
          }
          if (err instanceof NetworkError) {
            if (dispatchCtx === pluginContext) {
              await reportCoreError(err, requestForAttempt)
            }
            throw err
          }
          const retryErr = new RetryLimitError(
            typeof err === 'object' &&
              err &&
              'message' in err &&
              typeof (err as { message?: unknown }).message === 'string'
              ? (err as { message: string }).message
              : 'Retry limit reached',
            err
          )
          if (dispatchCtx === pluginContext) {
            await reportCoreError(retryErr, requestForAttempt)
          }
          throw retryErr
        }

        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, requestForAttempt)
        }
        await effectiveHooks.after?.(requestForAttempt, res)
        if (effectiveThrowOnHttpError && isHttpErrorStatus(res.status)) {
          const { HttpError } = await import('./error.js')
          throw new HttpError(
            `HTTP error: ${res.status} ${res.statusText}`,
            res
          )
        }
        return res
      }

      const baseDispatch: PluginDispatch = async (ctx) => {
        const dispatchSignal =
          ctx === pluginContext ? combinedSignal : ctx.request.signal
        return retryWithHooks(ctx, dispatchSignal)
      }

      let dispatch = baseDispatch
      for (let i = plugins.length - 1; i >= 0; i--) {
        const plugin = plugins[i]
        if (plugin.wrapDispatch) {
          dispatch = plugin.wrapDispatch(dispatch)
        }
      }

      let completeCalled = false
      const callComplete = async (
        response: Response | undefined,
        error: unknown
      ) => {
        if (completeCalled) return
        completeCalled = true
        await effectiveHooks.onComplete?.(request, response, error)
      }

      const actualPromise = dispatch(pluginContext)
        .then(async (response) => {
          await callComplete(response, undefined)
          for (const plugin of plugins) {
            await plugin.onSuccess?.(pluginContext, response)
          }
          return response
        })
        .catch(async (err: unknown) => {
          await reportCoreError(err, request)
          await callComplete(undefined, err)
          for (const plugin of plugins) {
            await plugin.onError?.(pluginContext, err)
          }
          throw err
        })

      const pendingEntry: PendingRequest = {
        promise: actualPromise,
        request,
        controller,
      }
      pendingRequests.push(pendingEntry)

      return actualPromise.finally(async () => {
        for (const plugin of plugins) {
          await plugin.onFinally?.(pluginContext)
        }

        const index = pendingRequests.indexOf(pendingEntry)
        if (index > -1) {
          pendingRequests.splice(index, 1)
        }
      })
    }

    let promise = execute() as Promise<Response>
    for (const plugin of plugins) {
      if (plugin.decoratePromise) {
        promise = plugin.decoratePromise(promise)
      }
    }
    return promise as Promise<Response> &
      PluginRequestPromiseExtensions<TPlugins>
  }

  Object.defineProperty(client, 'pendingRequests', {
    get() {
      return pendingRequests
    },
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(client, 'abortAll', {
    value: abortAll,
    writable: false,
    enumerable: false,
    configurable: false,
  })

  Object.defineProperties(client, extensionDescriptors)

  return client as FFetch<
    PluginExtensions<TPlugins>,
    PluginRequestPromiseExtensions<TPlugins>
  >
}
