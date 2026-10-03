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

  it('preserves a caller-provided id across retries without generating one', async () => {
    const seenIds: string[] = []
    const generate = vi.fn(() => 'generated-id')
    let call = 0

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      call++
      seenIds.push(request.headers.get('x-context-id') ?? '')
      return new Response(call < 3 ? 'fail' : 'ok', {
        status: call < 3 ? 500 : 200,
      })
    })

    const client = createClient({
      retries: 2,
      plugins: [contextIdPlugin({ generate })],
    })

    await client('https://example.com/retry', {
      headers: { 'x-context-id': 'caller-id' },
    })

    expect(seenIds).toEqual(['caller-id', 'caller-id', 'caller-id'])
    expect(generate).not.toHaveBeenCalled()
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

describe('context-id plugin traceparent', () => {
  it('emits a W3C traceparent header by default', async () => {
    const seen: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seen.push(request.headers.get('traceparent') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/trace-default')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  it('keeps a stable trace-id and unique span-id across retries', async () => {
    const seen: string[] = []
    let call = 0

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      call++
      seen.push(request.headers.get('traceparent') ?? '')
      if (call < 3) {
        return new Response('fail', { status: 500 })
      }
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      retries: 2,
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/trace-retry')

    expect(seen).toHaveLength(3)
    const parts = seen.map((header) => header.split('-'))
    const traceIds = new Set(parts.map((part) => part[1]))
    const spanIds = new Set(parts.map((part) => part[2]))
    expect(traceIds.size).toBe(1)
    expect(spanIds.size).toBe(3)
  })

  it('preserves incoming trace-id and flags while regenerating span-id', async () => {
    const seen: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seen.push(request.headers.get('traceparent') ?? '')
      return new Response('ok', { status: 200 })
    })

    const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const client = createClient({
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/trace-incoming', {
      headers: { traceparent: incoming },
    })

    expect(seen).toHaveLength(1)
    const parts = seen[0].split('-')
    expect(parts[0]).toBe('00')
    expect(parts[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(parts[3]).toBe('01')
    expect(parts[2]).toMatch(/^[0-9a-f]{16}$/)
    expect(parts[2]).not.toBe('00f067aa0ba902b7')
  })

  it('falls back to a generated trace-id when incoming traceparent is malformed', async () => {
    const seen: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seen.push(request.headers.get('traceparent') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin()],
    })

    await client('https://example.com/trace-malformed', {
      headers: { traceparent: 'not-a-valid-traceparent' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  it('keeps a stable trace-id and unique span-id across hedged attempts', async () => {
    vi.useFakeTimers()

    const seen: string[] = []
    let call = 0

    global.fetch = vi.fn().mockImplementation((request: Request) => {
      call++
      seen.push(request.headers.get('traceparent') ?? '')

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

    const requestPromise = client('https://example.com/trace-hedge')
    await vi.advanceTimersByTimeAsync(25)
    await requestPromise

    expect(seen).toHaveLength(2)
    const parts = seen.map((header) => header.split('-'))
    const traceIds = new Set(parts.map((part) => part[1]))
    const spanIds = new Set(parts.map((part) => part[2]))
    expect(traceIds.size).toBe(1)
    expect(spanIds.size).toBe(2)
  })

  it('does not emit traceparent when disabled', async () => {
    const seen: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seen.push(request.headers.get('traceparent') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin({ traceparent: false })],
    })

    await client('https://example.com/trace-off')

    expect(seen).toEqual([''])
  })

  it('supports custom trace flags', async () => {
    const seen: string[] = []

    global.fetch = vi.fn().mockImplementation(async (request: Request) => {
      seen.push(request.headers.get('traceparent') ?? '')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [contextIdPlugin({ traceparent: { flags: '00' } })],
    })

    await client('https://example.com/trace-flags')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/)
  })
})
