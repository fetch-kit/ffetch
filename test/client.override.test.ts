// Suppress unhandled promise rejections globally for this test file

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FFetchRequestInit } from '../src/types.js'
import { createClient } from '../src/client.js'

function mockFetchImpl(
  responseOrImpl: Response | ((..._args: unknown[]) => unknown),
  opts: { failTimes?: number } = {}
) {
  let callCount = 0
  globalThis.fetch = vi.fn(async (..._args: unknown[]) => {
    if (opts.failTimes && callCount < opts.failTimes) {
      callCount++
      return Promise.reject(new Error('fail'))
    }
    if (typeof responseOrImpl === 'function')
      return Promise.resolve(responseOrImpl(..._args))
    return Promise.resolve(responseOrImpl)
  }) as typeof fetch
}

describe('FFetch per-request override', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('overrides retries per request', async () => {
    const client = createClient({ retries: 0 })
    mockFetchImpl(new Response('ok'), { failTimes: 2 })
    await expect(
      client('http://x', { retries: 2 } as FFetchRequestInit)
    ).resolves.toBeInstanceOf(Response)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
  })

  it('overrides retryDelay per request', async () => {
    const delays: number[] = []
    const client = createClient({ retryDelay: ({ attempt: _attempt }) => 1 })
    mockFetchImpl(new Response('ok'), { failTimes: 2 })
    const origSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', (fn, ms) => {
      delays.push(ms)
      return origSetTimeout(fn, 0)
    })
    await client('http://x', {
      retries: 2,
      retryDelay: ({ attempt: _attempt }) => 43 + _attempt,
    })
    // Only check retry delays (ignore timeout delay, which is >= 1000ms)
    const retryDelays = delays.filter((d) => d < 1000)
    expect(retryDelays[0]).toBe(44)
    expect(retryDelays[1]).toBe(45)
  })

  it('overrides shouldRetry per request', async () => {
    const client = createClient({ shouldRetry: () => false, retries: 2 })
    let called = false
    mockFetchImpl(new Response('ok'), { failTimes: 1 })
    await client('http://x', {
      shouldRetry: (_ctx) => {
        called = true
        return true
      },
      retries: 1,
    } as FFetchRequestInit)
    expect(called).toBe(true)
  })

  it('overrides hooks per request', async () => {
    const before = vi.fn()
    const after = vi.fn()
    const client = createClient({
      hooks: {
        before: () => {
          throw new Error('should not call')
        },
      },
    })
    mockFetchImpl(new Response('ok'))
    await client('http://x', { hooks: { before, after } } as FFetchRequestInit)
    expect(before).toHaveBeenCalled()
    expect(after).toHaveBeenCalled()
  })

  it('falls back to client hooks if per-request hook not provided', async () => {
    const before = vi.fn()
    const client = createClient({ hooks: { before } })
    mockFetchImpl(new Response('ok'))
    await client('http://x', { hooks: {} } as FFetchRequestInit)
    expect(before).toHaveBeenCalled()
  })

  it('per-request options do not leak to subsequent requests', async () => {
    const client = createClient({ retries: 0 })
    mockFetchImpl(new Response('ok'), { failTimes: 1 })
    await client('http://x', { retries: 1 } as FFetchRequestInit)
    mockFetchImpl(new Response('ok'))
    await client('http://x')
    // Should not retry on second call
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('type safety: does not allow invalid per-request keys', () => {
    // @ts-expect-error: testing type safety for invalid per-request key
    createClient()('http://x', { notARealOption: 123 })
  })
})
