import type { ClientPlugin } from '../plugins.js'

export type DownloadProgressEvent = {
  percent: number
  transferredBytes: number
  totalBytes: number
}

export type DownloadProgressCallback = (
  progress: DownloadProgressEvent,
  chunk: Uint8Array
) => void

export function downloadProgressPlugin(
  onProgress: DownloadProgressCallback
): ClientPlugin {
  return {
    name: 'downloadProgress',
    wrapDispatch: (next) => async (ctx) => {
      const response = await next(ctx)

      if (!response.body) {
        return response
      }

      const contentLength = response.headers.get('content-length')
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0
      let transferredBytes = 0

      const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            transferredBytes += chunk.byteLength
            const percent = totalBytes > 0 ? transferredBytes / totalBytes : 0
            onProgress({ percent, transferredBytes, totalBytes }, chunk)
            controller.enqueue(chunk)
          },
        })
      )

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
  }
}
