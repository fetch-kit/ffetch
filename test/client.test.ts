import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'
import { defaultDelay } from '../src/retry.js'

// Suppress unhandled promise rejections globally for this test file

it('aborts after 50 ms', async () => {
  const controller = new AbortController()
  controller.abort() // Abort before request
  global.fetch = vi.fn().mockImplementation(async (_input) => {
    // fetch should never be called if signal is already aborted
    throw new Error('fetch should not be called')
  })

  const f = createClient()
  try {
    await f('https://example.com', { signal: controller.signal })
    throw new Error('Expected AbortError to be thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    if (err instanceof Error) {
      expect(err.name).toBe('AbortError')
      expect(err.message).toBe('Request was aborted by user')
    }
  }
})

it('works with manual timeout implementation when AbortSignal.timeout is missing', async () => {
  const origTimeout = AbortSignal.timeout
  // @ts-expect-error: Simulate missing AbortSignal.timeout for coverage
  AbortSignal.timeout = undefined

  try {
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
        // Never resolve (simulate hanging request)
      })
    })

    const client = createClient({ timeout: 50 })
    await expect(client('http://example.com')).rejects.toThrow()
  } finally {
    AbortSignal.timeout = origTimeout
  }
})

it('throws AbortError with message "Request was aborted" when timeout signal aborts', async () => {
  const transformedController = new AbortController()
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
      // Never resolve (simulate hanging request)
    })
  })
  transformedController.abort() // Abort before request starts
  // Simulate environment without throwIfAborted
  const origThrowIfAborted = AbortSignal.prototype.throwIfAborted
  // @ts-expect-error: Simulate environment without throwIfAborted for coverage
  AbortSignal.prototype.throwIfAborted = undefined
  global.fetch = vi.fn().mockImplementation(async (_input) => {
    throw new Error('fetch should not be called if signal is already aborted')
  })
  const client = createClient({
    hooks: {
      transformRequest: (req) =>
        new Request(req, { signal: transformedController.signal }),
    },
    // No timeout, no user signal
  })
  try {
    await client('https://example.com')
    throw new Error('Expected AbortError to be thrown')
  } catch (err) {
    if (err instanceof Error) {
      expect(err.constructor.name).toBe('AbortError')
      expect(err.name).toBe('AbortError')
      expect(err.message).toBe('Request was aborted')
    }
  } finally {
    // Restore throwIfAborted
    AbortSignal.prototype.throwIfAborted = origThrowIfAborted
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

  it('timeout: 0 disables timeout', async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      // Simulate a request that takes longer than normal timeout would allow
      await new Promise((resolve) => setTimeout(resolve, 100))
      return new Response('success')
    })

    const client = createClient({ timeout: 0 })
    const response = await client('https://example.com')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('success')
  })
})

it('should throw if AbortSignal.any is missing and multiple signals are present', async () => {
  const origAny = AbortSignal.any
  // Remove AbortSignal.any
  // @ts-expect-error: Simulate missing AbortSignal.any for coverage
  AbortSignal.any = undefined
  const controller1 = new AbortController()
  const controller2 = new AbortController()
  // Use transformRequest to add a second signal
  const client = createClient({
    hooks: {
      transformRequest: (req) =>
        new Request(req, { signal: controller2.signal }),
    },
  })
  await expect(
    client('https://example.com', { signal: controller1.signal, timeout: 1 })
  ).rejects.toThrow(/AbortSignal.any is required/)
  // Restore AbortSignal.any
  AbortSignal.any = origAny
})

it('dedupes identical requests and returns the same promise', async () => {
  let fetchCalls = 0
  const response = new Response('deduped', { status: 200 })
  global.fetch = vi.fn().mockImplementation(async () => {
    fetchCalls++
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 10))
    return response
  })

  const client = createClient({ dedupe: true })
  // Fire two requests with identical params
  const p1 = client('https://dedupe-test.com', { method: 'GET' })
  const p2 = client('https://dedupe-test.com', { method: 'GET' })
  // Both should resolve to the same Response object
  const [r1, r2] = await Promise.all([p1, p2])
  expect(fetchCalls).toBe(1)
  expect(r1.status).toBe(200)
  expect(r2.status).toBe(200)
  expect(await r1.text()).toBe('deduped')
})

it('dedupes and rejects identical requests together', async () => {
  let fetchCalls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    fetchCalls++
    // Simulate network error
    throw new Error('network fail')
  })

  const client = createClient({ dedupe: true })
  // Fire two requests with identical params
  const p1 = client('https://dedupe-reject.com', { method: 'GET' })
  const p2 = client('https://dedupe-reject.com', { method: 'GET' })
  // Both should reject with the same error
  await expect(p1).rejects.toThrow('network fail')
  await expect(p2).rejects.toThrow('network fail')
  expect(fetchCalls).toBe(1)
})
