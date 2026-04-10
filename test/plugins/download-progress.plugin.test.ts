import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { downloadProgressPlugin } from '../../src/plugins/download-progress.js'

function makeStreamResponse(
  chunks: Uint8Array[],
  contentLength?: number
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })

  const headers: HeadersInit = {}
  if (contentLength !== undefined) {
    headers['content-length'] = String(contentLength)
  }

  return new Response(stream, { status: 200, headers })
}

describe('downloadProgressPlugin', () => {
  it('calls onProgress for each chunk with correct transferredBytes', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ]
    const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0)

    const onProgress = vi.fn()

    const client = createClient({
      plugins: [downloadProgressPlugin(onProgress)],
      fetchHandler: async () => makeStreamResponse(chunks, totalBytes),
    })

    const response = await client('https://example.com/file')
    await response.arrayBuffer()

    expect(onProgress).toHaveBeenCalledTimes(3)

    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      { percent: 3 / 6, transferredBytes: 3, totalBytes: 6 },
      chunks[0]
    )
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      { percent: 5 / 6, transferredBytes: 5, totalBytes: 6 },
      chunks[1]
    )
    expect(onProgress).toHaveBeenNthCalledWith(
      3,
      { percent: 1, transferredBytes: 6, totalBytes: 6 },
      chunks[2]
    )
  })

  it('reports percent=0 and totalBytes=0 when Content-Length is absent', async () => {
    const onProgress = vi.fn()

    const client = createClient({
      plugins: [downloadProgressPlugin(onProgress)],
      fetchHandler: async () =>
        makeStreamResponse([new Uint8Array([1, 2, 3, 4])]),
    })

    const response = await client('https://example.com/unknown-length')
    await response.arrayBuffer()

    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(
      { percent: 0, transferredBytes: 4, totalBytes: 0 },
      new Uint8Array([1, 2, 3, 4])
    )
  })

  it('passes through the response body so it is still readable', async () => {
    const data = new Uint8Array([10, 20, 30])

    const client = createClient({
      plugins: [downloadProgressPlugin(vi.fn())],
      fetchHandler: async () => makeStreamResponse([data], data.byteLength),
    })

    const response = await client('https://example.com/readable')
    const buffer = await response.arrayBuffer()

    expect(new Uint8Array(buffer)).toEqual(data)
  })

  it('returns the response untouched when body is null', async () => {
    const onProgress = vi.fn()

    const client = createClient({
      plugins: [downloadProgressPlugin(onProgress)],
      fetchHandler: async () => new Response(null, { status: 204 }),
    })

    const response = await client('https://example.com/no-content')

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('preserves status, statusText, and headers on the wrapped response', async () => {
    const client = createClient({
      plugins: [downloadProgressPlugin(vi.fn())],
      fetchHandler: async () =>
        new Response(new ReadableStream({ start: (c) => c.close() }), {
          status: 206,
          statusText: 'Partial Content',
          headers: { 'x-custom': 'value', 'content-length': '0' },
        }),
    })

    const response = await client('https://example.com/partial')

    expect(response.status).toBe(206)
    expect(response.statusText).toBe('Partial Content')
    expect(response.headers.get('x-custom')).toBe('value')
  })

  it('accumulates bytes correctly across many small chunks', async () => {
    const chunkCount = 100
    const chunkSize = 512
    const chunks = Array.from({ length: chunkCount }, () =>
      new Uint8Array(chunkSize).fill(0xff)
    )
    const totalBytes = chunkCount * chunkSize

    const percents: number[] = []

    const client = createClient({
      plugins: [
        downloadProgressPlugin((progress) => {
          percents.push(progress.percent)
        }),
      ],
      fetchHandler: async () => makeStreamResponse(chunks, totalBytes),
    })

    const response = await client('https://example.com/many-chunks')
    await response.arrayBuffer()

    expect(percents).toHaveLength(chunkCount)
    expect(percents[percents.length - 1]).toBe(1)
    // percent is strictly increasing
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1])
    }
  })
})
