import type { RetryContext } from './types.js'

/**
 * How long to wait before an attempt is re-sent: a fixed delay, or a function of
 * the attempt that just finished.
 */
export type RetryDelay = number | ((ctx: RetryContext) => number)

/**
 * The delay a client uses when none is configured: what the response asks for
 * when it carries a `Retry-After`, and exponential backoff with jitter
 * otherwise. The sequence that waits it out lives in
 * `internals/retry-execution.ts`, which is the only caller.
 */
export const defaultDelay: RetryDelay = (ctx) => {
  const retryAfter = ctx.response?.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (!isNaN(date)) return Math.max(0, date - Date.now())
  }
  return 2 ** ctx.attempt * 200 + Math.random() * 100
}
