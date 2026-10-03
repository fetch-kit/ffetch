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

/**
 * Node error codes that mean the request never reached the server. `fetch`
 * reports them through the `cause` of a `TypeError('fetch failed')`, either
 * directly or inside an `AggregateError` with one entry per address tried.
 */
const TRANSPORT_ERROR_CODE =
  /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EPROTO|EADDRNOTAVAIL|UND_ERR_)/i

/**
 * Messages fetch implementations use for a transport failure, for example
 * Node's `fetch failed`, the browser's `Failed to fetch` and `NetworkError
 * when attempting to fetch resource.`, Safari's `Load failed`, and node-fetch's
 * `request to ... failed`. Only applied to `TypeError`s, which is what `fetch`
 * rejects with.
 */
const TRANSPORT_ERROR_MESSAGE =
  /fetch failed|failed to fetch|load failed|network ?error|network request failed|lost connection|socket hang up|other side closed|request to .* failed|connection (?:reset|refused|closed|timed out)|ERR_NETWORK/i

/** How deep a rejection's `cause`/`errors` chain is inspected. */
const TRANSPORT_ERROR_DEPTH = 5

/**
 * Whether `err` is a transport failure rather than an application error.
 *
 * `fetch` does not throw a single shape for network problems: Node rejects with
 * `TypeError('fetch failed')` and hangs the real reason off `cause` (an `Error`
 * with a `code` such as `ECONNREFUSED`, or an `AggregateError`), while browsers
 * use their own messages. The error and its `cause` chain are therefore
 * inspected instead of the top-level message, and only shapes that identify a
 * transport failure are claimed - anything else stays with the caller so it can
 * surface as a `RetryLimitError`.
 */
function isTransportError(
  err: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): boolean {
  if (depth > TRANSPORT_ERROR_DEPTH) return false
  if (typeof err !== 'object' || err === null || seen.has(err)) return false
  seen.add(err)

  const { code, name, message, errors, cause } = err as {
    code?: unknown
    name?: unknown
    message?: unknown
    errors?: unknown
    cause?: unknown
  }

  if (typeof code === 'string' && TRANSPORT_ERROR_CODE.test(code)) return true
  if (
    name === 'TypeError' &&
    typeof message === 'string' &&
    TRANSPORT_ERROR_MESSAGE.test(message)
  ) {
    return true
  }
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      if (isTransportError(inner, depth + 1, seen)) return true
    }
  }
  return isTransportError(cause, depth + 1, seen)
}

/**
 * The `name` of an object-shaped rejection. `fetch` rejects with whatever the
 * implementation produced - a `DOMException`, a plain `Error`, an error from
 * this library - and a custom `fetchHandler` may reject with anything at all,
 * so the property is read instead of the class being tested.
 */
function rejectionName(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as { name?: unknown }).name
}

/**
 * Whether a rejection value is a cancellation. `fetch` rejects with the abort
 * reason of the signal it was given, so a timed-out request rejects with a
 * `DOMException` named `TimeoutError`, `controller.abort(reason)` rejects with
 * `reason` verbatim - any value, including a plain `Error` or a string - and
 * node-fetch rejects with an `Error` named `AbortError`.
 */
function isCancellationReason(err: unknown): boolean {
  if (err instanceof AbortError || err instanceof TimeoutError) return true
  const name = rejectionName(err)
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Whether `err` is an error the core raises for the request itself: a
 * cancellation, a timeout, a transport failure, or retries running out. These
 * describe what happened to the request rather than who decided it, so they
 * keep their identity everywhere they are reported. An error that reports
 * another party's verdict - a plugin refusing a request, for example - is not
 * one of them and stays with whoever raised it.
 */
function isCoreError(
  err: unknown
): err is TimeoutError | AbortError | NetworkError | RetryLimitError {
  return (
    err instanceof TimeoutError ||
    err instanceof AbortError ||
    err instanceof NetworkError ||
    err instanceof RetryLimitError
  )
}

/** Tolerates a missing signal, so a call site can list every signal it has. */
function isSignalAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true
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

      const controller = new AbortController()
      // Everything the lifecycle callbacks need exists before the request is
      // prepared, so a hook that fails while it is still being prepared can
      // report the failure instead of escaping the pipeline.
      let pluginContext: PluginRequestContext | undefined
      // Registered in the same synchronous turn as the call itself, so
      // `pendingRequests` and `abortAll()` also cover request preparation.
      let pendingEntry: PendingRequest | undefined

      let completeCalled = false
      const callComplete = async (
        response: Response | undefined,
        error: unknown
      ) => {
        if (completeCalled) return
        completeCalled = true
        await effectiveHooks.onComplete?.(request, response, error)
      }

      let coreErrorReported = false
      const reportCoreError = async (error: unknown, hookRequest: Request) => {
        if (coreErrorReported || !isCoreError(error)) return

        coreErrorReported = true
        if (error instanceof TimeoutError) {
          await effectiveHooks.onTimeout?.(hookRequest)
        } else if (error instanceof AbortError) {
          await effectiveHooks.onAbort?.(hookRequest)
        }
        await effectiveHooks.onError?.(hookRequest, error)
      }

      // Cancellation settles a request that is still being prepared: a
      // preparation hook that never resolves would otherwise hold its promise
      // and its `pendingRequests` entry forever, because the signal the
      // dispatch path reads (`combinedSignal`) is not built until preparation
      // has finished.
      let cancelPreparation: ((error: AbortError) => void) | undefined
      const watchedSignals: AbortSignal[] = []
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancelPreparation = reject
      })

      const cancellationError = () =>
        init.signal?.aborted
          ? new AbortError('Request was aborted by user')
          : new AbortError('Request was aborted', request.signal.reason)

      const onCancellation = () => {
        cancelPreparation?.(cancellationError())
      }

      const stopWatching = () => {
        for (const signal of watchedSignals) {
          signal.removeEventListener('abort', onCancellation)
        }
        watchedSignals.length = 0
        cancelPreparation = undefined
      }

      const watchSignal = (signal?: AbortSignal | null) => {
        if (!signal || watchedSignals.includes(signal)) return
        watchedSignals.push(signal)
        if (signal.aborted) onCancellation()
        else signal.addEventListener('abort', onCancellation)
      }

      // Preparation and dispatch share one lifecycle boundary. A hook that fails
      // before the request is dispatched used to reject past the whole pipeline,
      // which skipped core `onComplete` and plugin `onError`/`onFinally` - the
      // lifecycle callbacks a caller relies on to release what it allocated.
      const preparation = (async () => {
        watchSignal(init.signal)
        watchSignal(request.signal)
        watchSignal(controller.signal)

        if (effectiveHooks.transformRequest) {
          request = await effectiveHooks.transformRequest(request)
          // The entry is registered before this resolves, so the request a
          // monitor reads stays the one that is being prepared.
          pendingEntry!.request = request
          // A replacement request can carry a signal of its own.
          watchSignal(request.signal)
        }
        await effectiveHooks.before?.(request)

        // Determine retry config (per-request overrides client default)
        const effectiveRetries = init.retries ?? clientDefaultRetries
        const effectiveRetryDelay =
          typeof init.retryDelay !== 'undefined'
            ? init.retryDelay
            : clientDefaultRetryDelay
        const effectiveShouldRetry =
          init.shouldRetry ?? clientDefaultShouldRetry

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

        const requestContext: PluginRequestContext = {
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
        pluginContext = requestContext

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

        if (effectiveTimeout > 0) {
          timeoutSignal = createTimeoutSignal(effectiveTimeout)
          pluginContext.metadata.signals.timeout = timeoutSignal
        }

        // The pipeline's own controller always joins the caller's and the
        // timeout signals, so there is always more than one signal to combine.
        // `AbortSignal.any` drops duplicates, so a repeated signal is harmless.
        const signals = [
          userSignal,
          transformedSignal,
          timeoutSignal,
          controller.signal,
        ].filter((signal): signal is AbortSignal => signal != null)

        if (typeof AbortSignal.any !== 'function') {
          throw new Error(
            'AbortSignal.any is required for combining multiple signals. Please install a polyfill for environments that do not support it.'
          )
        }
        combinedSignal = AbortSignal.any(signals)
        pluginContext.metadata.signals.combined = combinedSignal

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

          // The error the attempt itself failed with, when that is what leaves
          // the retry loop. It is the only error a `RetryLimitError` describes;
          // an error raised while the request was being prepared for an attempt
          // belongs to whoever raised it.
          let attemptFailure: unknown
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
                // A plugin can refuse an attempt by throwing here - when the
                // request is no longer admitted, for example. That happens
                // before the attempt is built, so it is not a failed attempt:
                // the plugin's error is the answer the request gets.
                for (const plugin of plugins) {
                  await plugin.beforeAttempt?.(dispatchCtx, attempt)
                }
                try {
                  const reqWithSignal =
                    attemptBody === null
                      ? new Request(requestForAttempt.clone(), {
                          signal: dispatchSignal,
                        })
                      : new Request(requestForAttempt, {
                          signal: dispatchSignal,
                          body: attemptBody.slice(),
                        })
                  const handler = init.fetchHandler ?? fetchHandler ?? fetch
                  const response = await handler(reqWithSignal)
                  dispatchCtx.metadata.retry.lastResponse = response
                  return response
                } catch (err) {
                  dispatchCtx.metadata.retry.lastError = err
                  // Building the request for the attempt counts as part of it:
                  // either way this is the error the attempt failed with.
                  attemptFailure = err
                  // Cancellation is read from the signals rather than from the
                  // rejection value: `fetch` rejects with the abort reason of the
                  // signal it was given, which is a `DOMException` named
                  // `TimeoutError` for a timeout and the value passed to
                  // `abort(reason)` - possibly a string - for a user abort.
                  const cancelled =
                    isCancellationReason(err) ||
                    isSignalAborted(timeoutSignal) ||
                    isSignalAborted(userSignal) ||
                    isSignalAborted(controller.signal) ||
                    isSignalAborted(dispatchSignal)
                  if (cancelled) {
                    if (
                      timeoutSignal?.aborted &&
                      (!userSignal || !userSignal.aborted)
                    ) {
                      throw new TimeoutError('signal timed out', err)
                    } else if (userSignal?.aborted) {
                      throw new AbortError('Request was aborted by user')
                    } else if (controller.signal.aborted) {
                      throw new AbortError('Request was aborted', err)
                    } else if (
                      err instanceof TimeoutError ||
                      err instanceof AbortError
                    ) {
                      // A custom `fetchHandler` can reject with the library's own
                      // errors, for example after running its own timer. Keep them
                      // as they are - re-wrapping would turn a `TimeoutError` into
                      // an `AbortError` and rewrite the message and the cause.
                      throw err
                    } else if (rejectionName(err) === 'TimeoutError') {
                      // Any other shape that names itself as a timeout, for
                      // example the `DOMException` from `AbortSignal.timeout()`.
                      throw new TimeoutError('signal timed out', err)
                    } else {
                      throw new AbortError('Request was aborted', err)
                    }
                  }
                  if (isTransportError(err)) {
                    throw new NetworkError(
                      err instanceof Error && err.message
                        ? err.message
                        : 'Network error occurred',
                      err
                    )
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
            // Errors the core raises for the request keep their identity, and
            // are the ones the lifecycle hooks describe.
            if (isCoreError(err)) {
              if (dispatchCtx === pluginContext) {
                await reportCoreError(err, requestForAttempt)
              }
              throw err
            }
            // Any other error was raised while the request was being prepared
            // for an attempt rather than by an attempt failing: a plugin
            // refusing it in `beforeAttempt`, or a retry hook that throws. The
            // raiser's error is the answer the request gets - re-labelling it
            // as a `RetryLimitError` would report the dependency as the reason.
            if (err !== attemptFailure) throw err
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

        // Bound to the context it was built for. Running it is what reaches the
        // network, so a preparation that was cancelled never runs it.
        return () => dispatch(requestContext)
      })()

      // Dispatch runs only once preparation settled, and a cancelled
      // preparation settles here instead of waiting for the hook that is stuck.
      const prepared = Promise.race([preparation, cancellation])
        .then((dispatch) => dispatch())
        .finally(stopWatching)
        .then(async (response) => {
          await callComplete(response, undefined)
          // A response can only come out of the pipeline, so the context that
          // describes the request is set by the time this runs.
          for (const plugin of plugins) {
            await plugin.onSuccess?.(pluginContext!, response)
          }
          return response
        })
        .catch(async (err: unknown) => {
          await reportCoreError(err, request)
          await callComplete(undefined, err)
          // Every plugin hears about the failure, and the first hook that fails
          // decides what the caller sees: a plugin reports an open circuit by
          // throwing from `onError`, so that error has to win over the failure
          // it replaces.
          if (pluginContext) {
            let hookFailed = false
            let hookError: unknown
            for (const plugin of plugins) {
              try {
                await plugin.onError?.(pluginContext, err)
              } catch (hookFailure) {
                if (!hookFailed) {
                  hookFailed = true
                  hookError = hookFailure
                }
              }
            }
            if (hookFailed) {
              throw hookError
            }
          }
          throw err
        })

      const entry: PendingRequest = { promise: prepared, request, controller }
      pendingEntry = entry
      pendingRequests.push(entry)

      /**
       * Teardown. Every plugin gets `onFinally` and the entry always leaves
       * `pendingRequests`, even when a hook throws, so a failing cleanup hook
       * cannot leak the request.
       *
       * A request that already failed keeps its error, while a request that
       * succeeded still fails when an `onFinally` hook throws: the first hook
       * error is thrown only where `propagateHookError` is set, which is the
       * success path.
       */
      const runFinally = async (propagateHookError: boolean) => {
        let hookFailed = false
        let hookError: unknown
        if (pluginContext) {
          for (const plugin of plugins) {
            try {
              await plugin.onFinally?.(pluginContext)
            } catch (err) {
              if (!hookFailed) {
                hookFailed = true
                hookError = err
              }
            }
          }
        }

        const index = pendingRequests.indexOf(entry)
        if (index > -1) {
          pendingRequests.splice(index, 1)
        }

        if (hookFailed && propagateHookError) {
          throw hookError
        }
      }

      return prepared.then(
        (response) => runFinally(true).then(() => response),
        (error) =>
          runFinally(false).then(() => {
            throw error
          })
      )
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
