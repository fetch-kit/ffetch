export interface FFetchOptions {
  timeout?: number
  retries?: number
  retryDelay?: number | ((attempt: number) => number)
  // …
}
