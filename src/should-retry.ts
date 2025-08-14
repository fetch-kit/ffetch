import { AbortError, CircuitOpenError, TimeoutError } from './error.js'

export function shouldRetry(err: unknown, res?: Response): boolean {
  if (
    err instanceof AbortError ||
    err instanceof CircuitOpenError ||
    err instanceof TimeoutError
  )
    return false
  if (!res) return true // network error
  return res.status >= 500 || res.status === 429
}
