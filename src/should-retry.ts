export function shouldRetry(err: unknown, res?: Response): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  if (!res) return true // network error
  return res.status >= 500 || res.status === 429
}
