import type { FFetchOptions, FFetch } from './types'
import { retry, defaultDelay } from './retry.js'
import { withTimeout } from './timeout.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import { CircuitBreaker } from './circuit.js'

export function createClient(opts: FFetchOptions = {}): FFetch {
  const {
    timeout = 5_000,
    retries = 0,
    retryDelay = defaultDelay,
    shouldRetry = defaultShouldRetry,
    hooks = {},
  } = opts

  const breaker = opts.circuit
    ? new CircuitBreaker(opts.circuit.threshold, opts.circuit.reset)
    : null

  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let request = new Request(input, init)
    if (hooks.transformRequest) {
      request = await hooks.transformRequest(request)
    }
    await hooks.before?.(request)
    let attempt = 0
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

    const doFetch = async () => {
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
            await hooks.onTimeout?.(request)
          }
          await hooks.onAbort?.(request)
        } else if (
          err instanceof Error &&
          (err.message.includes('timeout') || err.name === 'TimeoutError')
        ) {
          await hooks.onTimeout?.(request)
        }
        throw err
      }
    }
    // Wrap shouldRetry to call onRetry hook
    const shouldRetryWithHook = (err: unknown, res?: Response) => {
      const retrying = shouldRetry(err, res)
      if (retrying && attempt < retries) {
        hooks.onRetry?.(request, attempt, err, res)
      }
      attempt++
      return retrying
    }
    const retryWithHooks = async () => {
      try {
        let res = await retry(doFetch, retries, retryDelay, shouldRetryWithHook)
        if (hooks.transformResponse) {
          res = await hooks.transformResponse(res, request)
        }
        await hooks.after?.(request, res)
        await hooks.onComplete?.(request, res, undefined)
        return res
      } catch (err) {
        await hooks.onError?.(request, err)
        await hooks.onComplete?.(request, undefined, err)
        throw err
      }
    }
    if (breaker) {
      try {
        return await breaker.invoke(retryWithHooks)
      } catch (err) {
        if (err instanceof Error && err.message === 'Circuit open') {
          await hooks.onCircuitOpen?.(request)
        }
        await hooks.onError?.(request, err)
        await hooks.onComplete?.(request, undefined, err)
        throw err
      }
    } else {
      return retryWithHooks()
    }
  }
}
