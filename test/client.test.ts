import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'
import { defaultDelay } from '../src/retry.js'

describe('client hooks and error handling', () => {
  it('calls onTimeout and throws TimeoutError when timeout signal aborts', async () => {
    let timeoutCalled = false
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        )
      })
    })
    const client = createClient({
      timeout: 10,
      hooks: {
        onTimeout: () => {
          timeoutCalled = true
        },
      },
    })
    await expect(client('http://timeout-hook')).rejects.toThrow('timed out')
    expect(timeoutCalled).toBe(true)
  }, 1000)

  it('calls onAbort and throws AbortError when user aborts', async () => {
    let abortCalled = false
    global.fetch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response('abort', { status: 200 })
    })
    const controller = new AbortController()
    const client = createClient({
      hooks: {
        onAbort: () => {
          abortCalled = true
        },
      },
    })
    controller.abort()
    await expect(
      client('http://abort-hook', { signal: controller.signal })
    ).rejects.toThrow('aborted')
    expect(abortCalled).toBe(true)
  })

  it('returns last response if error occurs after response', async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response('ok', { status: 200 })
    })
    const client = createClient({
      throwOnHttpError: true,
      hooks: {
        transformResponse: async () => {
          throw new Error('fail after response')
        },
      },
    })
    const res = await client('http://last-response')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('client branch coverage targets', () => {
  it('passes undefined signal to dedupeHashFn when init.signal is null', async () => {
    let seenSignal: AbortSignal | undefined = undefined
    const client = createClient({
      dedupe: true,
      dedupeHashFn: (params) => {
        seenSignal = params.signal
        return undefined
      },
      fetchHandler: async () => new Response('ok', { status: 200 }),
    })

    await client('https://example.com/null-signal', {
      signal: null as unknown as AbortSignal,
    })
    expect(seenSignal).toBeUndefined()
  })

  it('throws TimeoutError before fetch when timeout signal is already aborted', async () => {
    const originalTimeout = AbortSignal.timeout
    try {
      AbortSignal.timeout = ((ms: number) => {
        void ms
        const c = new AbortController()
        c.abort()
        return c.signal
      }) as typeof AbortSignal.timeout

      const onTimeout = vi.fn()
      global.fetch = vi.fn().mockImplementation(async () => {
        throw new Error('fetch should not be called')
      })

      const client = createClient({ timeout: 10, hooks: { onTimeout } })
      await expect(
        client('https://example.com/pre-aborted-timeout')
      ).rejects.toThrow('signal timed out')
      expect(onTimeout).toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      AbortSignal.timeout = originalTimeout
    }
  })

  it('uses no-throwIfAborted fallback and throws AbortError when user aborts mid-check', async () => {
    const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted
    const originalAny = AbortSignal.any
    try {
      // @ts-expect-error coverage: force fallback branch
      AbortSignal.prototype.throwIfAborted = undefined

      const userController = new AbortController()
      AbortSignal.any = ((signals: AbortSignal[]) => {
        void signals
        return {
          get aborted() {
            userController.abort()
            return true
          },
        } as AbortSignal
      }) as typeof AbortSignal.any

      global.fetch = vi.fn().mockImplementation(async () => {
        throw new Error('fetch should not be called')
      })

      const client = createClient({ timeout: 60 })
      await expect(
        client('https://example.com/fallback-user-abort', {
          signal: userController.signal,
        })
      ).rejects.toThrow('Request was aborted by user')
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      AbortSignal.any = originalAny
      AbortSignal.prototype.throwIfAborted = originalThrowIfAborted
    }
  })

  it('uses no-throwIfAborted fallback and throws TimeoutError when timeout aborts mid-check', async () => {
    const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted
    const originalAny = AbortSignal.any
    const originalTimeout = AbortSignal.timeout
    try {
      // @ts-expect-error coverage: force fallback branch
      AbortSignal.prototype.throwIfAborted = undefined

      let timeoutAborted = false
      AbortSignal.timeout = ((ms: number) => {
        void ms
        return {
          get aborted() {
            return timeoutAborted
          },
        } as AbortSignal
      }) as typeof AbortSignal.timeout

      AbortSignal.any = ((signals: AbortSignal[]) => {
        void signals
        return {
          get aborted() {
            timeoutAborted = true
            return true
          },
        } as AbortSignal
      }) as typeof AbortSignal.any

      const onTimeout = vi.fn()
      global.fetch = vi.fn().mockImplementation(async () => {
        throw new Error('fetch should not be called')
      })

      const client = createClient({ timeout: 10, hooks: { onTimeout } })
      await expect(
        client('https://example.com/fallback-timeout-abort')
      ).rejects.toThrow('signal timed out')
      expect(onTimeout).toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      AbortSignal.timeout = originalTimeout
      AbortSignal.any = originalAny
      AbortSignal.prototype.throwIfAborted = originalThrowIfAborted
    }
  })
})

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

describe('dedupe cache TTL and sweeper', () => {
  const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

  it('should invalidate dedupe cache after TTL expires', async () => {
    let callCount = 0
    const client = createClient({
      dedupe: true,
      dedupeTTL: 50, // 50ms TTL
      dedupeSweepInterval: 20,
      fetchHandler: async (_input: RequestInfo | URL) => {
        callCount++
        await delay(10)
        return new Response('ok', { status: 200 })
      },
    })

    // First call, triggers fetch
    const p1 = client('http://ttl-test')
    // Second call, deduped
    const p2 = client('http://ttl-test')
    expect(p1).toStrictEqual(p2)
    await p1
    expect(callCount).toBe(1)

    // Wait for TTL to expire
    await delay(60)

    // Third call, should not be deduped (cache expired)
    const p3 = client('http://ttl-test')
    await p3
    expect(callCount).toBe(2)
  })

  it('should not reject deduped promises if TTL expires', async () => {
    let resolveFetch: (v: Response) => void
    const fetchPromise = new Promise<Response>((res) => {
      resolveFetch = res
    })
    const client = createClient({
      dedupe: true,
      dedupeTTL: 30,
      dedupeSweepInterval: 10,
      fetchHandler: async () => {
        return await fetchPromise
      },
    })

    const p1 = client('http://ttl-promise')
    const p2 = client('http://ttl-promise')
    expect(p1).toStrictEqual(p2)

    // Wait for TTL to expire
    await delay(40)

    // Promise should still be pending, not rejected
    let settled = false
    p1.then(() => {
      settled = true
    })
    await delay(10)
    expect(settled).toBe(false)

    // Now resolve the fetch
    resolveFetch!(new Response('done', { status: 200 }))
    await delay(10) // allow promise to settle
    expect(settled).toBe(true)
  })

  it('should clean up dedupeMap and stop sweeper when empty', async () => {
    const client = createClient({
      dedupe: true,
      dedupeTTL: 20,
      dedupeSweepInterval: 10,
      fetchHandler: async () => {
        return new Response('ok', { status: 200 })
      },
    })

    await client('http://cleanup')
    await delay(30) // Wait for TTL and sweeper

    // @ts-expect-error: access private for test
    expect(client._dedupeMap?.size ?? 0).toBe(0)
    // @ts-expect-error: access private for test
    expect(client._dedupeSweeper).toBeUndefined()
  })

  it('should dedupe even if dedupeTTL is 0 (no expiry)', async () => {
    let callCount = 0
    const client = createClient({
      dedupe: true,
      dedupeTTL: 0,
      fetchHandler: async () => {
        callCount++
        return new Response('ok', { status: 200 })
      },
    })
    const p1 = client('http://no-ttl')
    const p2 = client('http://no-ttl')
    expect(p1).toStrictEqual(p2)
    await p1
    expect(callCount).toBe(1)
  })
})
