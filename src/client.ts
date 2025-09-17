import type {
  FFetchOptions,
  FFetch,
  FFetchRequestInit,
  PendingRequest,
} from './types.js'
import { retry, defaultDelay } from './retry.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import { CircuitBreaker } from './circuit.js'
import {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from './error.js'

export function createClient(opts: FFetchOptions = {}): FFetch {
  const {
    timeout: clientDefaultTimeout = 5_000,
    retries: clientDefaultRetries = 0,
    retryDelay: clientDefaultRetryDelay = defaultDelay,
    shouldRetry: clientDefaultShouldRetry = defaultShouldRetry,
    hooks: clientDefaultHooks = {},
    circuit: clientDefaultCircuit,
    fetchHandler,
  } = opts

  const breaker = clientDefaultCircuit
    ? new CircuitBreaker(
        clientDefaultCircuit.threshold,
        clientDefaultCircuit.reset
      )
    : null

  if (
    breaker &&
    (clientDefaultHooks.onCircuitClose || clientDefaultHooks.onCircuitOpen)
  ) {
    breaker.setHooks({
      onCircuitClose: clientDefaultHooks.onCircuitClose,
      onCircuitOpen: clientDefaultHooks.onCircuitOpen,
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
    // No longer require AbortSignal.timeout - we'll implement it manually if needed
    let request = new Request(input, init)

    // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
    const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
    if (effectiveHooks.transformRequest) {
      request = await effectiveHooks.transformRequest(request)
    }
    await effectiveHooks.before?.(request)

    // Create timeout signal (manual implementation if AbortSignal.timeout not available)
    function createTimeoutSignal(timeout: number): AbortSignal {
      if (typeof AbortSignal?.timeout === 'function') {
        return AbortSignal.timeout(timeout)
      }

      // Manual implementation for older environments
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      // Clean up timeout if signal is aborted early by other means
      controller.signal.addEventListener(
        'abort',
        () => clearTimeout(timeoutId),
        { once: true }
      )

      return controller.signal
    }

    // AbortSignal.timeout/any logic ---
    const effectiveTimeout = init.timeout ?? clientDefaultTimeout
    const userSignal = init.signal
    const transformedSignal = request.signal // Extract signal from transformed request
    let timeoutSignal: AbortSignal | undefined = undefined
    let combinedSignal: AbortSignal | undefined = undefined
    let controller: AbortController | undefined = undefined

    if (effectiveTimeout > 0) {
      timeoutSignal = createTimeoutSignal(effectiveTimeout)
    }

    // Collect all signals that need to be combined
    const signals: AbortSignal[] = []
    if (userSignal) signals.push(userSignal)
    if (transformedSignal && transformedSignal !== userSignal) {
      signals.push(transformedSignal)
    }
    if (timeoutSignal) signals.push(timeoutSignal)

    // Use AbortSignal.any for signal combination. Requires native support or a polyfill.
    // If not available, instruct users to install a polyfill for environments lacking AbortSignal.any.
    // there are always 1 or more signals
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
    const retryWithHooks = async () => {
      const effectiveRetries = init.retries ?? clientDefaultRetries
      const effectiveRetryDelay =
        typeof init.retryDelay !== 'undefined'
          ? init.retryDelay
          : clientDefaultRetryDelay
      const effectiveShouldRetry = init.shouldRetry ?? clientDefaultShouldRetry

      // Wrap shouldRetry to call onRetry hook
      let attempt = 0
      const shouldRetryWithHook = (ctx: import('./types').RetryContext) => {
        attempt = ctx.attempt
        const retrying = effectiveShouldRetry(ctx)
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

      function mapToCustomError(err: unknown): unknown {
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (timeoutSignal?.aborted && (!userSignal || !userSignal.aborted)) {
            return new TimeoutError('signal timed out', err)
          } else {
            return new AbortError('Request was aborted', err)
          }
        } else if (
          err instanceof TypeError &&
          /NetworkError|network error|failed to fetch|lost connection|NetworkError when attempting to fetch resource/i.test(
            err.message
          )
        ) {
          return new NetworkError(err.message, err)
        }
        return err
      }

      async function handleError(err: unknown): Promise<never> {
        err = mapToCustomError(err)
        // If user aborted, always throw AbortError, not RetryLimitError
        if (userSignal?.aborted) {
          const abortErr = new AbortError('Request was aborted by user')
          await effectiveHooks.onAbort?.(request)
          await effectiveHooks.onError?.(request, abortErr)
          await effectiveHooks.onComplete?.(request, undefined, abortErr)
          throw abortErr
        }
        // If the error is a custom error, re-throw it directly (do not wrap)
        if (
          err instanceof TimeoutError ||
          err instanceof NetworkError ||
          err instanceof AbortError
        ) {
          if (err instanceof TimeoutError) {
            await effectiveHooks.onTimeout?.(request)
          }
          if (err instanceof AbortError) {
            await effectiveHooks.onAbort?.(request)
          }
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        // Otherwise, throw RetryLimitError after all retries are exhausted
        const retryErr = new RetryLimitError(
          typeof err === 'object' &&
          err &&
          'message' in err &&
          typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : 'Retry limit reached'
        )
        await effectiveHooks.onError?.(request, retryErr)
        await effectiveHooks.onComplete?.(request, undefined, retryErr)
        throw retryErr
      }

      try {
        let res = await retry(
          async () => {
            // Use AbortSignal.throwIfAborted() before starting fetch
            if (typeof combinedSignal?.throwIfAborted === 'function') {
              combinedSignal.throwIfAborted()
            } else if (combinedSignal?.aborted) {
              throw new AbortError('Request was aborted')
            }
            const reqWithSignal = new Request(request, {
              signal: combinedSignal,
            })
            try {
              const handler = fetchHandler ?? fetch
              const response = await handler(reqWithSignal)
              // Circuit breaker: record result
              if (breaker) {
                if (breaker.recordResult(response, undefined, request)) {
                  throw new Error(`HTTP error: ${response.status}`)
                }
              }
              return response
            } catch (err) {
              if (breaker) breaker.recordResult(undefined, err, request)
              throw mapToCustomError(err)
            }
          },
          effectiveRetries,
          effectiveRetryDelay,
          shouldRetryWithHook,
          request
        )
        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, request)
        }
        await effectiveHooks.after?.(request, res)
        await effectiveHooks.onComplete?.(request, res, undefined)
        return res
      } catch (err: unknown) {
        await handleError(err)
        throw new Error('Unreachable: handleError should always throw')
      }
    }

    const promise = breaker
      ? breaker.invoke(retryWithHooks).catch(async (err: unknown) => {
          if (err instanceof CircuitOpenError) {
            await effectiveHooks.onCircuitOpen?.(request)
            await effectiveHooks.onError?.(request, err)
            await effectiveHooks.onComplete?.(request, undefined, err)
          } else {
            await effectiveHooks.onError?.(request, err)
            await effectiveHooks.onComplete?.(request, undefined, err)
          }
          throw err
        })
      : retryWithHooks()

    const entry: PendingRequest = {
      promise,
      request,
      controller,
    }
    pendingRequests.push(entry)

    return promise.finally(() => {
      const index = pendingRequests.indexOf(entry)
      if (index > -1) {
        pendingRequests.splice(index, 1)
      }
    })
  }

  // Add pendingRequests property to the client function (read-only)
  Object.defineProperty(client, 'pendingRequests', {
    get() {
      return pendingRequests
    },
    enumerable: false,
    configurable: false,
  })

  // Add abortAll method to the client function (read-only)
  Object.defineProperty(client, 'abortAll', {
    value: abortAll,
    writable: false,
    enumerable: false,
    configurable: false,
  })

  // Expose circuit breaker open state
  Object.defineProperty(client, 'circuitOpen', {
    get() {
      return breaker ? breaker.open : false
    },
    enumerable: true,
  })

  return client as FFetch
}
