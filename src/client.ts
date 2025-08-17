import type { FFetchOptions, FFetch, FFetchRequestInit } from './types.js'
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
    // Check for AbortSignal.timeout before any async logic
    if (
      typeof AbortSignal === 'undefined' ||
      typeof AbortSignal.timeout !== 'function'
    ) {
      throw new Error(
        'AbortSignal.timeout is required. Please use a polyfill for older environments.'
      )
    }

    let request = new Request(input, init)

    // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
    const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
    if (effectiveHooks.transformRequest) {
      request = await effectiveHooks.transformRequest(request)
    }
    await effectiveHooks.before?.(request)

    // AbortSignal.timeout/any logic ---
    const effectiveTimeout = init.timeout ?? clientDefaultTimeout
    const userSignal = init.signal
    let timeoutSignal: AbortSignal | undefined = undefined
    let combinedSignal: AbortSignal | undefined = undefined
    timeoutSignal = AbortSignal.timeout(effectiveTimeout)
    if (userSignal) {
      if (typeof AbortSignal.any === 'function') {
        combinedSignal = AbortSignal.any([userSignal, timeoutSignal])
      } else {
        // Fallback: use userSignal if already aborted, else timeoutSignal
        combinedSignal = userSignal.aborted ? userSignal : timeoutSignal
      }
    } else {
      combinedSignal = timeoutSignal
    }

    // Restore hook-wrapped retry, enforce global timeout externally
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
              return await fetch(reqWithSignal)
            } catch (err) {
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
