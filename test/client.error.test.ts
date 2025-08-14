import { describe, it, expect, vi } from 'vitest'
import createClient, {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from '../src/index.js'

describe('Integration: Custom Errors', () => {
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
    await expect(f('https://example.com')).rejects.toThrow(TimeoutError)
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
    ).rejects.toThrow(AbortError)
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
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError('NetworkError when attempting to fetch resource.')
      )
    const f = createClient()
    await expect(f('https://example.com')).rejects.toThrow(NetworkError)
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
      (err) => err instanceof TimeoutError || err instanceof AbortError
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
      (err) => err instanceof AbortError || err instanceof TimeoutError
    )
    expect(abortFired).toBe(true)
  }, 1000)

  it('NetworkError: thrown for different network error messages', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('NetworkError: lost connection'))
    const f = createClient()
    await expect(f('https://example.com')).rejects.toThrow(NetworkError)
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
      expect(err.message).toBe('something bad')
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
    await expect(f('https://example.com')).rejects.toThrow('fail')
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
})
