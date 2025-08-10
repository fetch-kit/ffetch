export type RetryDelay = number | ((attempt: number) => number)

export const defaultDelay: RetryDelay = (n) =>
  2 ** n * 200 + Math.random() * 100

export async function retry<T>(
  fn: () => Promise<T>,
  retries: number,
  delay: RetryDelay,
  shouldRetry: (err: unknown, res?: T) => boolean = () => true
): Promise<T> {
  let lastErr: unknown
  let lastRes: T | undefined

  for (let i = 0; i <= retries; i++) {
    try {
      lastRes = await fn()
      // Check if we should retry based on the resolved value (e.g., HTTP status)
      if (i < retries && shouldRetry(undefined, lastRes)) {
        const wait = typeof delay === 'function' ? delay(i + 1) : delay
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      return lastRes
    } catch (err) {
      lastErr = err
      if (i === retries || !shouldRetry(err, lastRes)) throw err
      const wait = typeof delay === 'function' ? delay(i + 1) : delay
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}
