import { describe, it, expect, vi, afterEach } from 'vitest'

import { createClient } from '../../src/client.js'
import { HttpError } from '../../src/error.js'
import { dedupePlugin } from '../../src/plugins/dedupe.js'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dedupe plugin parity', () => {
  it('dedupes concurrent requests with the same key', async () => {
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      plugins: [dedupePlugin()],
    })

    const p1 = client('https://example.com/dedupe')
    const p2 = client('https://example.com/dedupe')
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('does not dedupe when hashFn returns undefined', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }))

    const client = createClient({
      plugins: [
        dedupePlugin({
          hashFn: () => undefined,
        }),
      ],
    })

    await Promise.all([
      client('https://example.com/no-dedupe'),
      client('https://example.com/no-dedupe'),
    ])

    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('evicts stale dedupe key after TTL while preserving in-flight promises', async () => {
    vi.useFakeTimers()

    const resolvers: Array<(value: Response) => void> = []
    global.fetch = vi.fn().mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve)
      })
    })

    const client = createClient({
      plugins: [dedupePlugin({ ttl: 10, sweepInterval: 5 })],
    })

    const p1 = client('https://example.com/ttl')
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    let p2 = client('https://example.com/ttl')
    for (let i = 0; i < 10 && fetchMock.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(5)
      p2 = client('https://example.com/ttl')
    }

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(resolvers).toHaveLength(2)

    resolvers[0](new Response('first', { status: 200 }))
    resolvers[1](new Response('second', { status: 200 }))

    await expect(p1).resolves.toBeInstanceOf(Response)
    await expect(p2).resolves.toBeInstanceOf(Response)
  })

  it('keeps dedupe key while within TTL window', async () => {
    vi.useFakeTimers()

    let resolver: ((value: Response) => void) | undefined
    global.fetch = vi.fn().mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        resolver = resolve
      })
    })

    const client = createClient({
      plugins: [dedupePlugin({ ttl: 100, sweepInterval: 10 })],
    })

    const p1 = client('https://example.com/ttl-window')
    await vi.advanceTimersByTimeAsync(40)
    const p2 = client('https://example.com/ttl-window')

    expect(global.fetch).toHaveBeenCalledTimes(1)

    resolver?.(new Response('ok', { status: 200 }))
    await Promise.all([p1, p2])
  })

  it('supports custom hash function parity behavior', async () => {
    const seenMethods: string[] = []

    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }))

    const client = createClient({
      plugins: [
        dedupePlugin({
          hashFn: (params) => {
            seenMethods.push(params.method)
            return `${params.method}:${params.url}`
          },
        }),
      ],
    })

    await Promise.all([
      client('https://example.com/hash', { method: 'POST', body: 'a' }),
      client('https://example.com/hash', { method: 'POST', body: 'b' }),
    ])

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(seenMethods).toEqual(['POST', 'POST'])
  })

  it('passes through a defined signal to custom hashFn', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined

    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }))

    const client = createClient({
      plugins: [
        dedupePlugin({
          hashFn: (params) => {
            seenSignal = params.signal
            return undefined
          },
        }),
      ],
    })

    await client('https://example.com/with-signal', {
      signal: controller.signal,
    })

    expect(seenSignal).toBe(controller.signal)
  })

  it('propagates one underlying failure to all deduped callers', async () => {
    const deferred = createDeferred<Response>()
    global.fetch = vi.fn().mockReturnValue(deferred.promise)

    const client = createClient({
      throwOnHttpError: true,
      retries: 0,
      plugins: [dedupePlugin()],
    })

    const p1 = client('https://example.com/reject')
    const p2 = client('https://example.com/reject')

    const handled1 = p1.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error })
    )
    const handled2 = p2.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error })
    )

    deferred.resolve(new Response('boom', { status: 500 }))

    const [r1, r2] = await Promise.all([handled1, handled2])
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    if (!r1.ok) {
      expect(r1.error).toBeInstanceOf(HttpError)
    }
    if (!r2.ok) {
      expect(r2.error).toBeInstanceOf(HttpError)
    }
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
