import {
  AbortError,
  NetworkError,
  RetryLimitError,
  TimeoutError,
} from '../error.js'

/**
 * HTTP statuses that `throwOnHttpError` turns into an `HttpError`.
 */
export function isHttpErrorStatus(status: number): boolean {
  return (
    (status >= 400 && status < 500 && status !== 429) ||
    status >= 500 ||
    status === 429
  )
}

/**
 * Whether `err` is an error the core raises for the request itself: a
 * cancellation, a timeout, a transport failure, or retries running out. These
 * describe what happened to the request rather than who decided it, so they
 * keep their identity everywhere they are reported. An error that reports
 * another party's verdict - a plugin refusing a request, for example - is not
 * one of them and stays with whoever raised it.
 */
export function isCoreError(
  err: unknown
): err is TimeoutError | AbortError | NetworkError | RetryLimitError {
  return (
    err instanceof TimeoutError ||
    err instanceof AbortError ||
    err instanceof NetworkError ||
    err instanceof RetryLimitError
  )
}
