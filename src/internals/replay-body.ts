import type { FFetchRequestInit } from '../types.js'

/**
 * Body values that ffetch owns in memory, so reading one before the first
 * attempt cannot stall an upload that is still in flight.
 */
function isOwnedBody(body: FFetchRequestInit['body']): boolean {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData
  )
}

/**
 * Whether the body can be copied before the first attempt so that a retry can
 * send it again. Only a body ffetch owns is safe to copy: a `ReadableStream`
 * needs `duplex: 'half'`, and a `Request` input or a request returned by a
 * `transformRequest` hook can carry an upload that only ends when the server
 * acknowledges it, so buffering one would stall the first attempt. Those
 * requests keep the previous behaviour instead and skip the body on a retry.
 */
export function canReplayBody(
  input: RequestInfo | URL,
  init: FFetchRequestInit,
  hasTransformRequest: boolean
): boolean {
  if (hasTransformRequest) return false
  if (input instanceof Request) return false
  return isOwnedBody(init.body)
}

/**
 * Reads the request body so that a retry can send it again. Sending a request
 * consumes its body, so the copy has to be taken before the first attempt, and
 * reading a clone leaves the original request untouched. Each attempt then gets
 * an independent body instead of a clone of the already-sent request, which
 * fails with "unusable".
 *
 * Only called for a body ffetch owns, which is why the request always has one.
 */
export async function captureReplayableBody(
  request: Request
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer())
  } catch {
    // The body is already consumed, for example by a hook: keep the previous
    // behaviour rather than failing here.
    return null
  }
}
