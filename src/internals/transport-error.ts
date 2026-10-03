import { AbortError, TimeoutError } from '../error.js'

/**
 * Node error codes that mean the request never reached the server. `fetch`
 * reports them through the `cause` of a `TypeError('fetch failed')`, either
 * directly or inside an `AggregateError` with one entry per address tried.
 */
const TRANSPORT_ERROR_CODE =
  /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EPROTO|EADDRNOTAVAIL|UND_ERR_)/i

/**
 * Messages fetch implementations use for a transport failure, for example
 * Node's `fetch failed`, the browser's `Failed to fetch` and `NetworkError
 * when attempting to fetch resource.`, Safari's `Load failed`, and node-fetch's
 * `request to ... failed`. Only applied to `TypeError`s, which is what `fetch`
 * rejects with.
 */
const TRANSPORT_ERROR_MESSAGE =
  /fetch failed|failed to fetch|load failed|network ?error|network request failed|lost connection|socket hang up|other side closed|request to .* failed|connection (?:reset|refused|closed|timed out)|ERR_NETWORK/i

/** How deep a rejection's `cause`/`errors` chain is inspected. */
const TRANSPORT_ERROR_DEPTH = 5

/**
 * Whether `err` is a transport failure rather than an application error.
 *
 * `fetch` does not throw a single shape for network problems: Node rejects with
 * `TypeError('fetch failed')` and hangs the real reason off `cause` (an `Error`
 * with a `code` such as `ECONNREFUSED`, or an `AggregateError`), while browsers
 * use their own messages. The error and its `cause` chain are therefore
 * inspected instead of the top-level message, and only shapes that identify a
 * transport failure are claimed - anything else stays with the caller so it can
 * surface as a `RetryLimitError`.
 */
export function isTransportError(
  err: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): boolean {
  if (depth > TRANSPORT_ERROR_DEPTH) return false
  if (typeof err !== 'object' || err === null || seen.has(err)) return false
  seen.add(err)

  const { code, name, message, errors, cause } = err as {
    code?: unknown
    name?: unknown
    message?: unknown
    errors?: unknown
    cause?: unknown
  }

  if (typeof code === 'string' && TRANSPORT_ERROR_CODE.test(code)) return true
  if (
    name === 'TypeError' &&
    typeof message === 'string' &&
    TRANSPORT_ERROR_MESSAGE.test(message)
  ) {
    return true
  }
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      if (isTransportError(inner, depth + 1, seen)) return true
    }
  }
  return isTransportError(cause, depth + 1, seen)
}

/**
 * The `name` of an object-shaped rejection. `fetch` rejects with whatever the
 * implementation produced - a `DOMException`, a plain `Error`, an error from
 * this library - and a custom `fetchHandler` may reject with anything at all,
 * so the property is read instead of the class being tested.
 */
export function rejectionName(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as { name?: unknown }).name
}

/**
 * Whether a rejection value is a cancellation. `fetch` rejects with the abort
 * reason of the signal it was given, so a timed-out request rejects with a
 * `DOMException` named `TimeoutError`, `controller.abort(reason)` rejects with
 * `reason` verbatim - any value, including a plain `Error` or a string - and
 * node-fetch rejects with an `Error` named `AbortError`.
 */
export function isCancellationReason(err: unknown): boolean {
  if (err instanceof AbortError || err instanceof TimeoutError) return true
  const name = rejectionName(err)
  return name === 'AbortError' || name === 'TimeoutError'
}
