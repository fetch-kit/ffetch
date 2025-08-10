import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'

it('aborts after 50 ms', async () => {
  global.fetch = vi
    .fn()
    .mockImplementation(
      async (_: RequestInfo | URL, { signal }: RequestInit = {}) => {
        await new Promise((r) => setTimeout(r, 100))
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        return new Response('ok')
      }
    ) as typeof global.fetch

  const f = createClient({ timeout: 50 })
  await expect(f('https://example.com')).rejects.toThrow()
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
    const customShouldRetry = (err: unknown, res?: Response): boolean => {
      if (res) {
        return res.status === 503
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
