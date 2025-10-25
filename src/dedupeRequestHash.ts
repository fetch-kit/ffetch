export type DedupeHashParams = {
  method: string
  url: string
  body:
    | string
    | FormData
    | URLSearchParams
    | Blob
    | ArrayBuffer
    | BufferSource
    | null
    | ReadableStream<unknown>
  headers?: Headers | Record<string, string>
  signal?: AbortSignal
  requestInit?: RequestInit
  request?: Request
}

export function dedupeRequestHash(
  params: DedupeHashParams
): string | undefined {
  const { method, url, body } = params
  let bodyString = ''
  if (body instanceof FormData) {
    // Skip deduplication for FormData
    return undefined
  }
  // Skip deduplication for ReadableStream
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return undefined
  }
  if (typeof body === 'string') {
    bodyString = body
  } else if (body instanceof URLSearchParams) {
    bodyString = body.toString()
  } else if (body instanceof ArrayBuffer) {
    bodyString = Buffer.from(body).toString('base64')
  } else if (body instanceof Uint8Array) {
    bodyString = Buffer.from(body).toString('base64')
  } else if (body instanceof Blob) {
    bodyString = `[blob:${body.type}:${body.size}]`
  } else if (body == null) {
    bodyString = ''
  } else {
    try {
      bodyString = JSON.stringify(body)
    } catch {
      bodyString = '[unserializable-body]'
    }
  }
  return `${method.toUpperCase()}|${url}|${bodyString}`
}
