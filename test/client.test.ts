import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'
import { defaultDelay } from '../src/retry.js'

// Suppress unhandled promise rejections globally for this test file

it('aborts after 50 ms', async () => {
  global.fetch = vi.fn().mockImplementation(async (input) => {
    const signal = input instanceof Request ? input.signal : undefined
    return await new Promise((_resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
      } else if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
      // Otherwise, never resolve (simulate hanging request)
    })
  })

  const f = createClient({ timeout: 50 })
  await expect(f('https://example.com')).rejects.toThrow()
})

it('throws if AbortSignal.timeout is missing', async () => {
  const origTimeout = AbortSignal.timeout
  // @ts-expect-error: Simulate missing AbortSignal.timeout for coverage
  AbortSignal.timeout = undefined
  const client = createClient()
  try {
    await expect(client('http://x')).rejects.toThrow(
      /AbortSignal\.timeout is required/
    )
  } finally {
    AbortSignal.timeout = origTimeout
  }
})

describe('retry', () => {
  it('retries 2 times and then succeeds', async () => {
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw new Error('network down')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const f = createClient({ retries: 2 })
    const res = await f('https://example.com')
    expect(res.status).toBe(200)
    expect(calls).toBe(3) // 1 initial + 2 retries
  })

  it('throws after 3 failures', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('boom'))
    const f = createClient({ retries: 2 })
    await expect(f('https://example.com')).rejects.toThrow('boom')
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })
})

describe('retry with shouldRetry', () => {
  it('retries network error', async () => {
    let calls = 0
    global.fetch = vi
      .fn()
      .mockImplementation(() =>
        ++calls < 3
          ? Promise.reject(new Error('fail'))
          : Promise.resolve(new Response())
      )
    const f = createClient({ retries: 2 })
    const res = await f('https://example.com') // will succeed
    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry 400', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }))
    const f = createClient({ retries: 2 })
    const res = await f('https://example.com')
    expect(res.status).toBe(400)
    expect(global.fetch).toHaveBeenCalledTimes(1) // only once
  })
})

describe('custom shouldRetry', () => {
  it('uses custom retry policy and retries only once', async () => {
    // custom policy that only retries on 503
    const customShouldRetry = (
      ctx: import('../src/types').RetryContext
    ): boolean => {
      if (ctx.response) {
        return ctx.response.status === 503
      }
      return false
    }

    // mock fetch that returns 503 then 200
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return new Response('', { status: 503 })
      }
      return new Response('success', { status: 200 }) // second call succeeds
    })

    // create client with custom policy and retries: 1
    const f = createClient({ retries: 2, shouldRetry: customShouldRetry })

    // call and expect a resolved Response with status 200 after retry
    const res = await f('https://example.com')
    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(2) // 1 retry
  })

  it('uses default retry policy and retries on 500', async () => {
    // mock fetch that returns 500 then 200
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return new Response('', { status: 500 }) // first call returns 500
      }
      return new Response('success', { status: 200 }) // second call succeeds
    })

    // create client with default policy and retries: 1
    const f = createClient({ retries: 1 })

    // call and expect a resolved Response with status 200 after retry
    const res = await f('https://example.com')
    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(2) // 1 retry
  })

  it('does NOT retry on 400 with default policy', async () => {
    // mock fetch that returns 400
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }))

    // create client with default policy and retries: 1
    const f = createClient({ retries: 1 })

    // call and expect a resolved Response with status 400
    const res = await f('https://example.com')
    expect(res.status).toBe(400)
    expect(global.fetch).toHaveBeenCalledTimes(1) // no retry
  })
})

describe('Retry-After header', () => {
  it('respects Retry-After header (seconds)', () => {
    const response = new Response('', { status: 429 })
    Object.defineProperty(response, 'headers', {
      value: {
        get: (name: string) => (name === 'Retry-After' ? '2' : undefined),
      },
    })
    const ctx = { attempt: 1, request: new Request('x'), response }
    const delay =
      typeof defaultDelay === 'function' ? defaultDelay(ctx) : defaultDelay
    expect(delay).toBe(2000)
  })

  it('respects Retry-After header (date)', () => {
    // Mock Date.now for deterministic test
    const fixedNow = 2000000000000 // some fixed timestamp
    const originalNow = Date.now
    Date.now = () => fixedNow
    try {
      const date = new Date(fixedNow + 5000).toUTCString()
      const response = new Response('', { status: 429 })
      Object.defineProperty(response, 'headers', {
        value: {
          get: (name: string) => (name === 'Retry-After' ? date : undefined),
        },
      })
      const ctx = { attempt: 1, request: new Request('x'), response }
      const delay =
        typeof defaultDelay === 'function' ? defaultDelay(ctx) : defaultDelay
      expect(delay).toBe(5000)
    } finally {
      Date.now = originalNow
    }
  })
})
