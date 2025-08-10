export const withTimeout = (
  ms: number,
  signal?: AbortSignal | null
): AbortSignal => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    ctrl.abort()
  })
  return ctrl.signal
}
