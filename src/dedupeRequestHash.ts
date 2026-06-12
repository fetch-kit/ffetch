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

function toBase64(bytes: Uint8Array): string {
  // Use Node Buffer when available, otherwise fall back to btoa for browser-like runtimes.
  const maybeBuffer = (
    globalThis as {
      Buffer?: {
        from(input: Uint8Array): { toString(encoding: string): string }
      }
    }
  ).Buffer
  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString('base64')
  }

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  if (typeof btoa === 'function') {
    return btoa(binary)
  }

  throw new Error('Base64 encoding is not available in this runtime')
}

export function dedupeRequestHash(
  params: DedupeHashParams
): string | undefined {
  const { method, url, body } = params
  let bodyString: string
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
    bodyString = toBase64(new Uint8Array(body))
  } else if (body instanceof Uint8Array) {
    bodyString = toBase64(body)
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
