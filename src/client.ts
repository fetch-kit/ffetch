import type { FFetchOptions, FFetch, FFetchRequestInit } from './types.js'
import { retry, defaultDelay } from './retry.js'
// ...existing code...
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
  } = opts

  const breaker = clientDefaultCircuit
    ? new CircuitBreaker(
        clientDefaultCircuit.threshold,
        clientDefaultCircuit.reset
      )
    : null

  const client: FFetch = async (
    input: RequestInfo | URL,
    init: FFetchRequestInit = {}
  ) => {
    let request = new Request(input, init)
    // ...existing code...
    // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
    const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
    if (effectiveHooks.transformRequest) {
      request = await effectiveHooks.transformRequest(request)
    }
    await effectiveHooks.before?.(request)
    // Combine two signals so abort from either source will abort the request
    // ...existing code...

    // Restore hook-wrapped retry, enforce global timeout externally
    const retryWithHooks = async () => {
      const effectiveTimeout = init.timeout ?? clientDefaultTimeout
      const effectiveRetries = init.retries ?? clientDefaultRetries
      const effectiveRetryDelay =
        typeof init.retryDelay !== 'undefined'
          ? init.retryDelay
          : clientDefaultRetryDelay
      const effectiveShouldRetry = init.shouldRetry ?? clientDefaultShouldRetry

      // Global timeout controller and elapsed time tracking
      const timeoutCtrl = new AbortController()
      const startTime = Date.now()
      let didTimeout = false
      const timeoutTimer = setTimeout(() => {
        didTimeout = true
        timeoutCtrl.abort()
      }, effectiveTimeout)

      // Compose user and timeout signals
      const userSignal = init.signal || undefined
      function combinedSignal() {
        if (!userSignal) return timeoutCtrl.signal
        if (userSignal.aborted) {
          timeoutCtrl.abort()
          return timeoutCtrl.signal
        }
        userSignal.addEventListener('abort', () => timeoutCtrl.abort())
        return timeoutCtrl.signal
      }

      // Wrap shouldRetry to call onRetry hook
      let attempt = 0
      const shouldRetryWithHook = (err: unknown, res?: Response) => {
        attempt++
        const retrying = effectiveShouldRetry(err, res)
        if (retrying && attempt <= effectiveRetries) {
          effectiveHooks.onRetry?.(request, attempt - 1, err, res)
        }
        return retrying
      }

      try {
        let res = await retry(
          async () => {
            // Check elapsed time before each attempt
            const elapsed = Date.now() - startTime
            if (elapsed >= effectiveTimeout) {
              didTimeout = true
              await effectiveHooks.onTimeout?.(request)
              throw new TimeoutError('Request timed out')
            }
            const reqWithSignal = new Request(request, {
              signal: combinedSignal(),
            })
            try {
              const r = await fetch(reqWithSignal)
              return r
            } catch (err: unknown) {
              if (err instanceof DOMException && err.name === 'AbortError') {
                // Check elapsed time after abort
                const elapsedAbort = Date.now() - startTime
                if (userSignal?.aborted) {
                  await effectiveHooks.onAbort?.(request)
                  throw new AbortError('Request was aborted')
                } else if (didTimeout || elapsedAbort >= effectiveTimeout) {
                  await effectiveHooks.onTimeout?.(request)
                  throw new TimeoutError('Request timed out')
                } else {
                  throw new AbortError('Request was aborted')
                }
              } else if (
                err instanceof Error &&
                (err.message.includes('timeout') || err.name === 'TimeoutError')
              ) {
                await effectiveHooks.onTimeout?.(request)
                throw new TimeoutError(err.message)
              } else if (
                err instanceof TypeError &&
                err.message &&
                err.message.includes('NetworkError')
              ) {
                throw new NetworkError(err.message)
              }
              throw err
            }
          },
          effectiveRetries,
          effectiveRetryDelay,
          shouldRetryWithHook
        )
        clearTimeout(timeoutTimer)
        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, request)
        }
        await effectiveHooks.after?.(request, res)
        await effectiveHooks.onComplete?.(request, res, undefined)
        return res
      } catch (err: unknown) {
        clearTimeout(timeoutTimer)
        // If the error is a known custom error, re-throw it directly
        if (
          err instanceof TimeoutError ||
          err instanceof AbortError ||
          err instanceof NetworkError
        ) {
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
    }

    // ...replaced above...
    if (breaker) {
      try {
        return await breaker.invoke(retryWithHooks)
      } catch (err: unknown) {
        if (err instanceof CircuitOpenError) {
          await effectiveHooks.onCircuitOpen?.(request)
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        await effectiveHooks.onError?.(request, err)
        await effectiveHooks.onComplete?.(request, undefined, err)
        throw err
      }
    } else {
      return retryWithHooks()
    }
  }

  return client
}
