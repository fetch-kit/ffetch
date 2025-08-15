import type { RetryContext } from './types.js'

export type RetryDelay = number | ((ctx: RetryContext) => number)

export const defaultDelay: RetryDelay = (ctx) =>
  2 ** ctx.attempt * 200 + Math.random() * 100

export async function retry(
  fn: () => Promise<Response>,
  retries: number,
  delay: RetryDelay,
  shouldRetry: (ctx: RetryContext) => boolean = () => true,
  request: Request
): Promise<Response> {
  let lastErr: unknown
  let lastRes: Response | undefined

  for (let i = 0; i <= retries; i++) {
    const ctx: RetryContext = {
      attempt: i + 1,
      request,
      response: lastRes,
      error: lastErr,
    }
    try {
      lastRes = await fn()
      ctx.response = lastRes
      ctx.error = undefined
      if (i < retries && shouldRetry(ctx)) {
        const wait = typeof delay === 'function' ? delay(ctx) : delay
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      return lastRes
    } catch (err) {
      lastErr = err
      ctx.error = err
      if (i === retries || !shouldRetry(ctx)) throw err
      const wait = typeof delay === 'function' ? delay(ctx) : delay
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}
