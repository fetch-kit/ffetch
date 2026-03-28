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
  type ClientPlugin,
  type PluginExtensionBase,
} from './plugins.js'
import {
  TimeoutError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from './error.js'

export function createClient<
  TPlugins extends
    readonly ClientPlugin<PluginExtensionBase>[] = readonly ClientPlugin<PluginExtensionBase>[],
>(
  opts: FFetchOptions<TPlugins> = {} as FFetchOptions<TPlugins>
): FFetch<PluginExtensions<TPlugins>> {
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

  const client = async (
    input: RequestInfo | URL,
    init: FFetchRequestInit = {}
  ) => {
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
    let controller: AbortController | undefined = undefined

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

    if (signals.length === 1) {
      combinedSignal = signals[0]
      controller = new AbortController()
    } else {
      if (typeof AbortSignal.any !== 'function') {
        throw new Error(
          'AbortSignal.any is required for combining multiple signals. Please install a polyfill for environments that do not support it.'
        )
      }
      combinedSignal = AbortSignal.any(signals)
      controller = new AbortController()
    }
    pluginContext.metadata.signals.combined = combinedSignal

    const retryWithHooks = async () => {
      let attempt = 0
      const shouldRetryWithHook = (ctx: import('./types').RetryContext) => {
        attempt = ctx.attempt
        pluginContext.metadata.retry.attempt = attempt
        pluginContext.metadata.retry.lastError = ctx.error
        pluginContext.metadata.retry.lastResponse = ctx.response
        const retrying = effectiveShouldRetry(ctx)
        pluginContext.metadata.retry.shouldRetryResult = retrying
        if (retrying && attempt <= effectiveRetries) {
          effectiveHooks.onRetry?.(
            request,
            attempt - 1,
            ctx.error,
            ctx.response
          )
        }
        return retrying
      }

      let lastResponse: Response | undefined = undefined
      try {
        let res = await retry(
          async () => {
            if (userSignal?.aborted) {
              effectiveHooks.onAbort?.(request)
              throw new AbortError('Request was aborted by user')
            }
            if (timeoutSignal?.aborted) {
              effectiveHooks.onTimeout?.(request)
              throw new TimeoutError('signal timed out')
            }
            if (typeof combinedSignal?.throwIfAborted === 'function') {
              combinedSignal.throwIfAborted()
            } else if (combinedSignal?.aborted) {
              if (userSignal?.aborted) {
                effectiveHooks.onAbort?.(request)
                throw new AbortError('Request was aborted by user')
              } else if (timeoutSignal?.aborted) {
                effectiveHooks.onTimeout?.(request)
                throw new TimeoutError('signal timed out')
              } else {
                throw new AbortError(
                  'Request was aborted',
                  new DOMException('Aborted', 'AbortError')
                )
              }
            }
            const reqWithSignal = new Request(request, {
              signal: combinedSignal,
            })
            try {
              const handler = init.fetchHandler ?? fetchHandler ?? fetch
              const response = await handler(reqWithSignal)
              lastResponse = response
              pluginContext.metadata.retry.lastResponse = response
              return response
            } catch (err) {
              pluginContext.metadata.retry.lastError = err
              if (err instanceof DOMException && err.name === 'AbortError') {
                if (
                  timeoutSignal?.aborted &&
                  (!userSignal || !userSignal.aborted)
                ) {
                  effectiveHooks.onTimeout?.(request)
                  throw new TimeoutError('signal timed out', err)
                } else if (userSignal?.aborted) {
                  effectiveHooks.onAbort?.(request)
                  throw new AbortError('Request was aborted by user')
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
          request,
          combinedSignal
        )
        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, request)
        }
        await effectiveHooks.after?.(request, res)
        await effectiveHooks.onComplete?.(request, res, undefined)
        if (
          effectiveThrowOnHttpError &&
          ((res.status >= 400 && res.status < 500 && res.status !== 429) ||
            res.status >= 500 ||
            res.status === 429)
        ) {
          const { HttpError } = await import('./error.js')
          throw new HttpError(
            `HTTP error: ${res.status} ${res.statusText}`,
            res
          )
        }
        return res
      } catch (err: unknown) {
        pluginContext.metadata.retry.lastError = err
        if (lastResponse) {
          const resp = lastResponse as Response
          if (
            effectiveThrowOnHttpError &&
            ((resp.status >= 400 && resp.status < 500 && resp.status !== 429) ||
              resp.status >= 500 ||
              resp.status === 429)
          ) {
            const { HttpError } = await import('./error.js')
            throw new HttpError(
              `HTTP error: ${resp.status} ${resp.statusText}`,
              resp
            )
          }
          return resp
        }
        if (err instanceof TimeoutError) {
          await effectiveHooks.onTimeout?.(request)
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        if (err instanceof AbortError) {
          await effectiveHooks.onAbort?.(request)
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        if (err instanceof NetworkError) {
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
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
        await effectiveHooks.onError?.(request, retryErr)
        await effectiveHooks.onComplete?.(request, undefined, retryErr)
        throw retryErr
      }
    }

    const baseDispatch: PluginDispatch = async () => retryWithHooks()

    let dispatch = baseDispatch
    for (let i = plugins.length - 1; i >= 0; i--) {
      const plugin = plugins[i]
      if (plugin.wrapDispatch) {
        dispatch = plugin.wrapDispatch(dispatch)
      }
    }

    const actualPromise = dispatch(pluginContext)
      .then(async (response) => {
        for (const plugin of plugins) {
          await plugin.onSuccess?.(pluginContext, response)
        }
        return response
      })
      .catch(async (err: unknown) => {
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

  return client as FFetch<PluginExtensions<TPlugins>>
}
