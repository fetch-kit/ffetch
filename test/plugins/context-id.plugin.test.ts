import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { contextIdPlugin } from '../../src/plugins/context-id.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('context-id plugin', () => {
  it('injects x-context-id by default', async () => {
    const seenIds: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seenIds.push(request.headers.get('x-context-id') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/default')

    expect(seenIds).toHaveLength(1)
    expect(seenIds[0]).toMatch(/.+/)
  })

  it('uses the same id for all retry attempts of one logical request', async () => {
    const seenIds: string[] = []
    let call = 0

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      call++
      seenIds.push(request.headers.get('x-context-id') ?? '')
      if (call < 3) {
        return new Response('fail', { status: 500 })
      }
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      retries: 2,
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/retry')

    expect(seenIds).toHaveLength(3)
    expect(new Set(seenIds).size).toBe(1)
  })

  it('uses the same id for all hedged attempts of one logical request', async () => {
    vi.useFakeTimers()

    const seenIds: string[] = []
    let call = 0

    global.fetch = vi.fn().mockImplementation((request: Request) => {
      call++
      seenIds.push(request.headers.get('x-context-id') ?? '')

      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(`ok-${call}`, { status: 200 })),
          call === 1 ? 100 : 1
        )

        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true }
        )
      })
    })

    const client = createClient({
      plugins: [contextIdPlugin(), hedgePlugin({ delay: 10, maxHedges: 1 })],
    })

    const requestPromise = client('https://example.com/hedge')
    await vi.advanceTimersByTimeAsync(25)
    const response = await requestPromise

    expect(response.status).toBe(200)
    expect(seenIds).toHaveLength(2)
    expect(new Set(seenIds).size).toBe(1)
  })

  it('supports custom generate and inject functions', async () => {
    const seenCustomHeaders: string[] = []
    const seenDefaultHeaders: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seenCustomHeaders.push(request.headers.get('x-correlation-id') ?? '')
      seenDefaultHeaders.push(request.headers.get('x-context-id') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [
        contextIdPlugin({
          generate: () => 'req-123',
          inject: (id, request) => {
            request.headers.set('x-correlation-id', `ctx-${id}`)
          },
        }),
      ],
    })

    await client('https://example.com/custom')

    expect(seenCustomHeaders).toEqual(['ctx-req-123'])
    expect(seenDefaultHeaders).toEqual([''])
  })

  it('falls back to Date.now/Math.random id generation when crypto.randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1710000000000)
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789)

    const seenIds: string[] = []
    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seenIds.push(request.headers.get('x-context-id') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/fallback-id')

    expect(seenIds).toHaveLength(1)
    const expectedFallbackId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    expect(seenIds[0]).toBe(expectedFallbackId)
  })
})
