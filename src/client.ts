import type { FFetchOptions, FFetch, FFetchRequestInit } from './types.js'
import { retry, defaultDelay } from './retry.js'
import { withTimeout } from './timeout.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import { CircuitBreaker } from './circuit.js'

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
    let attempt = 0
    // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
    const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
    if (effectiveHooks.transformRequest) {
      request = await effectiveHooks.transformRequest(request)
    }
    await effectiveHooks.before?.(request)
    // Combine two signals so abort from either source will abort the request
    function combineSignals(
      signalA?: AbortSignal,
      signalB?: AbortSignal
    ): AbortSignal | undefined {
      if (!signalA) return signalB
      if (!signalB) return signalA
      const controller = new AbortController()
      function forwardAbort(signal: AbortSignal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort())
      }
      forwardAbort(signalA)
      forwardAbort(signalB)
      return controller.signal
    }

    const doFetch = async (timeout: number) => {
      const timeoutSignal = withTimeout(timeout, undefined) || undefined
      const userSignal = init.signal || undefined
      const combinedSignal = combineSignals(timeoutSignal, userSignal)
      const reqWithSignal = combinedSignal
        ? new Request(request, { signal: combinedSignal })
        : request
      try {
        const res = await fetch(reqWithSignal)
        return res
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // If a timeout is set, treat AbortError as a timeout
          if (timeout !== undefined && timeout !== null) {
            await effectiveHooks.onTimeout?.(request)
          }
          await effectiveHooks.onAbort?.(request)
        } else if (
          err instanceof Error &&
          (err.message.includes('timeout') || err.name === 'TimeoutError')
        ) {
          await effectiveHooks.onTimeout?.(request)
        }
        throw err
      }
    }

    const retryWithHooks = async () => {
      // Merge per-request options with client defaults here to ensure latest values
      const effectiveTimeout = init.timeout ?? clientDefaultTimeout
      const effectiveRetries = init.retries ?? clientDefaultRetries
      const effectiveRetryDelay =
        typeof init.retryDelay !== 'undefined'
          ? init.retryDelay
          : clientDefaultRetryDelay
      const effectiveShouldRetry = init.shouldRetry ?? clientDefaultShouldRetry

      // Wrap shouldRetry to call onRetry hook
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
          () => doFetch(effectiveTimeout),
          effectiveRetries,
          effectiveRetryDelay,
          shouldRetryWithHook
        )
        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, request)
        }
        await effectiveHooks.after?.(request, res)
        await effectiveHooks.onComplete?.(request, res, undefined)
        return res
      } catch (err) {
        await effectiveHooks.onError?.(request, err)
        await effectiveHooks.onComplete?.(request, undefined, err)
        throw err
      }
    }
    if (breaker) {
      try {
        return await breaker.invoke(retryWithHooks)
      } catch (err) {
        if (err instanceof Error && err.message === 'Circuit open') {
          await effectiveHooks.onCircuitOpen?.(request)
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
