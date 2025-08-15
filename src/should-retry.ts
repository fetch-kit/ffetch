import { AbortError, CircuitOpenError, TimeoutError } from './error.js'
import type { RetryContext } from './types.js'

export function shouldRetry(ctx: RetryContext): boolean {
  const { error, response } = ctx
  if (
    error instanceof AbortError ||
    error instanceof CircuitOpenError ||
    error instanceof TimeoutError
  )
    return false
  if (!response) return true // network error
  return response.status >= 500 || response.status === 429
}
