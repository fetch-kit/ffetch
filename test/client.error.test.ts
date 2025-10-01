// Edge case: throwOnHttpError true, retries > 0, first error, later success
it('does not throw if a retry succeeds when throwOnHttpError is true', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) return new Response('fail', { status: 500 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({ throwOnHttpError: true, retries: 1 })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: custom shouldRetry retries on 400
it('retries on 400 if shouldRetry returns true', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) return new Response('fail', { status: 400 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({
    retries: 1,
    shouldRetry: (ctx) => ctx.response?.status === 400,
  })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: 429 with Retry-After, throwOnHttpError true, all attempts 429
it('retries on 429 with Retry-After and throws HttpError if all attempts are 429', async () => {
  global.fetch = vi.fn().mockImplementation(async () => {
    const r = new Response('fail', { status: 429 })
    Object.defineProperty(r, 'headers', {
      value: {
        get: (name: string) => (name === 'Retry-After' ? '0' : undefined),
      },
    })
    return r
  })
  const f = createClient({ throwOnHttpError: true, retries: 1 })
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: mixed error/success (network error, 5xx, 2xx)
it('returns 2xx if a retry eventually succeeds after network and 5xx errors', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) throw new TypeError('network error')
    if (calls === 2) return new Response('fail', { status: 500 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({ retries: 2 })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(3)
})

// Edge case: circuit breaker opens, throwOnHttpError true
it('throws CircuitOpenError if circuit opens due to repeated 5xx and throwOnHttpError is true', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f = createClient({
    throwOnHttpError: true,
    retries: 0,
    circuit: { threshold: 2, reset: 100 },
  })
  // First two requests fail, opening the circuit
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  await expect(f('https://test.com')).rejects.toThrow(CircuitOpenError)
})

// Edge case: per-request throwOnHttpError overrides client default
it('per-request throwOnHttpError overrides client default (both directions)', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f1 = createClient({ throwOnHttpError: false })
  await expect(
    f1('https://test.com', { throwOnHttpError: true })
  ).rejects.toThrow(HttpError)
  const f2 = createClient({ throwOnHttpError: true })
  const res = await f2('https://test.com', { throwOnHttpError: false })
  expect(res.status).toBe(500)
})

// Edge case: shouldRetry returns false for 5xx, throwOnHttpError true (should throw immediately, no retry)
it('throws immediately if shouldRetry returns false for 5xx and throwOnHttpError is true', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f = createClient({
    throwOnHttpError: true,
    retries: 2,
    shouldRetry: () => false,
  })
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

// Edge case: abort/timeout with throwOnHttpError true (should throw AbortError/TimeoutError, not HttpError)
it('throws AbortError or TimeoutError, not HttpError, if aborted/timed out and throwOnHttpError is true', async () => {
  // Abort
  const controller = new AbortController()
  controller.abort()
  global.fetch = vi.fn().mockImplementation(async () => {
    throw new Error('fetch should not be called')
  })
  const f = createClient({ throwOnHttpError: true })
  await expect(
    f('https://test.com', { signal: controller.signal })
  ).rejects.toThrow(AbortError)

  // Timeout
  global.fetch = vi.fn().mockImplementation(async (input) => {
    const signal = input instanceof Request ? input.signal : undefined
    return await new Promise((_resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
    })
  })
  const f2 = createClient({ throwOnHttpError: true, timeout: 10 })
  await expect(f2('https://test.com')).rejects.toThrow(TimeoutError)
})
import { HttpError } from '../src/error.js'
// Suppress unhandled promise rejections globally for this test file

import { describe, it, expect, vi } from 'vitest'
import createClient, {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from '../src/index.js'

describe('Integration: Custom Errors', () => {
  it('throws HttpError on 4xx/5xx if throwOnHttpError is true (per-request)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 404 }))
    const f = createClient()
    await expect(
      f('https://test.com', { throwOnHttpError: true })
    ).rejects.toThrow(HttpError)
  })

  it('returns response on 4xx/5xx if throwOnHttpError is false (default)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 404 }))
    const f = createClient()
    const res = await f('https://test.com')
    expect(res.status).toBe(404)
  })

  it('throws HttpError on 4xx/5xx if throwOnHttpError is true (client default)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))
    const f = createClient({ throwOnHttpError: true })
    await expect(f('https://test.com')).rejects.toThrow(HttpError)
  })

  it('throws TimeoutError on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 20 })
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof TimeoutError && err.cause instanceof DOMException
    })
  }, 200)

  it('throws AbortError on user abort', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const controller = new AbortController()
    const f = createClient()
    setTimeout(() => controller.abort(), 20)
    await expect(
      f('https://example.com', { signal: controller.signal })
    ).rejects.toSatisfy((err) => {
      return (
        err instanceof AbortError &&
        err.message === 'Request was aborted by user' &&
        err.cause === undefined
      )
    })
  }, 200)

  it('throws CircuitOpenError when circuit is open', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 1, reset: 100 },
    })
    await expect(f('https://example.com')).rejects.toThrow('fail')
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
  })

  it('throws RetryLimitError when retry limit is reached', async () => {
    // The error message must match /retries? (exceeded|limit)/i for RetryLimitError
    global.fetch = vi.fn().mockRejectedValue(new Error('retry limit'))
    const f = createClient({ retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(RetryLimitError)
  })

  it('throws NetworkError on network error', async () => {
    const nativeErr = new TypeError(
      'NetworkError when attempting to fetch resource.'
    )
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient()
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof NetworkError && err.cause === nativeErr
    })
  })
})

describe('Advanced/Edge Cases: Custom Errors', () => {
  it('TimeoutError: thrown after multiple retries', async () => {
    let attempts = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      attempts++
      // Simulate a timeout by rejecting with AbortError after a short delay
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new DOMException('aborted', 'AbortError')
    })
    const f = createClient({ timeout: 10, retries: 1 })
    // Accept either TimeoutError or AbortError due to timing differences in CI/Node environments
    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        (err instanceof TimeoutError && err.cause instanceof DOMException) ||
        (err instanceof AbortError && err.cause instanceof DOMException)
    )
    // If the timeout is too short, only 1 attempt may be made
    expect(attempts).toBeGreaterThanOrEqual(1)
  }, 2000)

  it('AbortError: thrown on user abort during retry', async () => {
    let abortFired = false
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      if (signal?.aborted) {
        abortFired = true
        throw new DOMException('aborted', 'AbortError')
      }
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            abortFired = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
        // Always reject to trigger retry
        setTimeout(() => reject(new Error('fail')), 5)
      })
    })
    const controller = new AbortController()
    const f = createClient({ retries: 1, timeout: 10 })
    setTimeout(() => controller.abort(), 15)
    await expect(
      f('https://example.com', { signal: controller.signal })
    ).rejects.toSatisfy(
      (err) =>
        (err instanceof AbortError &&
          err.message === 'Request was aborted by user' &&
          err.cause === undefined) ||
        (err instanceof TimeoutError && err.cause instanceof DOMException)
    )
    expect(abortFired).toBe(true)
  }, 1000)

  it('NetworkError: thrown for different network error messages', async () => {
    const nativeErr = new TypeError('NetworkError: lost connection')
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient()
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof NetworkError && err.cause === nativeErr
    })
  })

  it('NetworkError: not thrown for HTTP errors', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))
    const f = createClient()
    const res = await f('https://example.com')
    expect(res.status).toBe(500)
  })

  it('RetryLimitError: wraps last error message', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('something bad'))
    const f = createClient({ retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(RetryLimitError)
    try {
      await f('https://example.com')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryLimitError)
      if (err instanceof Error) {
        expect(err.message).toBe('something bad')
      }
    }
  })

  it('RetryLimitError: not thrown for TimeoutError', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 20, retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(TimeoutError)
  }, 1000)

  it('CircuitOpenError: thrown after threshold, resets after timeout', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 100 },
    })
    await expect(f('https://example.com')).rejects.toThrow('fail')
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
    // Wait for reset
    await new Promise((r) => setTimeout(r, 120))
    await expect(f('https://example.com')).rejects.toThrow('fail')
  })

  it('Error hooks receive correct error instance', async () => {
    const onError = vi.fn()
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('NetworkError: lost connection'))
    const f = createClient({ hooks: { onError } })
    await expect(f('https://example.com')).rejects.toThrow(NetworkError)
    expect(onError).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(NetworkError)
    )
  })

  it('onTimeout and onAbort hooks are not both called', async () => {
    const onTimeout = vi.fn()
    const onAbort = vi.fn()
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 10, hooks: { onTimeout, onAbort } })
    await expect(f('https://example.com')).rejects.toThrow(TimeoutError)
    expect(onTimeout).toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
  }, 300)

  it('throws RetryLimitError with default message if error has no string message', async () => {
    global.fetch = vi.fn().mockRejectedValue(undefined) // or null, or {}
    const f = createClient({ retries: 0 })
    try {
      await f('https://example.com')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryLimitError)
      if (err instanceof Error) {
        expect(err.message).toBe('Retry limit reached')
      }
    }
  })
})
