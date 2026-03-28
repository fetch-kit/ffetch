import type { RetryContext } from './types.js'

export type RetryDelay = number | ((ctx: RetryContext) => number)

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

function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }

    if (signal.aborted) {
      resolve()
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function retry(
  fn: () => Promise<Response>,
  retries: number,
  delay: RetryDelay,
  shouldRetry: (ctx: RetryContext) => boolean = () => true,
  request: Request,
  signal?: AbortSignal
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
        await waitForRetryDelay(wait, signal)
        continue
      }
      return lastRes
    } catch (err) {
      lastErr = err
      ctx.error = err
      if (i === retries || !shouldRetry(ctx)) throw err
      const wait = typeof delay === 'function' ? delay(ctx) : delay
      await waitForRetryDelay(wait, signal)
    }
  }
  throw lastErr
}
