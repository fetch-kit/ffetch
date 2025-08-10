import { retry, defaultDelay, RetryDelay } from './retry.js'
import { withTimeout } from './timeout.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import { CircuitBreaker } from './circuit.js'

export function createClient(
  opts: {
    timeout?: number
    retries?: number
    retryDelay?: RetryDelay
    shouldRetry?: (err: unknown, res?: Response) => boolean
    circuit?: { threshold: number; reset: number }
  } = {}
) {
  const {
    timeout = 5_000,
    retries = 0,
    retryDelay = defaultDelay,
    shouldRetry = defaultShouldRetry,
  } = opts

  const breaker = opts.circuit
    ? new CircuitBreaker(opts.circuit.threshold, opts.circuit.reset)
    : null

  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const doFetch = () => {
      const signal = withTimeout(timeout, init.signal)
      return fetch(input, { ...init, signal })
    }
    const fetchWithRetry = () =>
      retry(doFetch, retries, retryDelay, (err, res) => shouldRetry(err, res))
    return breaker ? breaker.invoke(fetchWithRetry) : fetchWithRetry()
  }
}
