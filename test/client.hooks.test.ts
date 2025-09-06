import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../src/client.js'

describe('Hooks', () => {
  it('calls before, after, and onComplete hooks on success', async () => {
    const before = vi.fn()
    const after = vi.fn()
    const onComplete = vi.fn()
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'))
    const f = createClient({ hooks: { before, after, onComplete } })
    const res = await f('https://example.com')
    expect(before).toHaveBeenCalled()
    expect(after).toHaveBeenCalledWith(expect.any(Request), res)
    expect(onComplete).toHaveBeenCalledWith(expect.any(Request), res, undefined)
  })

  it('calls onError and onComplete hooks on failure', async () => {
    const onError = vi.fn()
    const onComplete = vi.fn()
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({ hooks: { onError, onComplete } })
    await expect(f('https://example.com')).rejects.toThrow('fail')
    expect(onError).toHaveBeenCalledWith(expect.any(Request), expect.any(Error))
    expect(onComplete).toHaveBeenCalledWith(
      expect.any(Request),
      undefined,
      expect.any(Error)
    )
  })

  it('calls onRetry hook on retry', async () => {
    const onRetry = vi.fn()
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      return new Response('ok')
    })
    const f = createClient({ retries: 2, hooks: { onRetry } })
    await f('https://example.com')
    expect(onRetry).toHaveBeenCalled()
    expect(onRetry.mock.calls.length).toBe(2)
  })

  it('calls onTimeout hook on timeout', async () => {
    const onTimeout = vi.fn()
    global.fetch = vi.fn().mockImplementation(async (input) => {
      // Listen for abort event and reject when it fires
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
    const f = createClient({ timeout: 10, hooks: { onTimeout } })
    await expect(f('https://example.com')).rejects.toThrow()
    expect(onTimeout).toHaveBeenCalled()
  })

  it('calls onAbort hook on abort', async () => {
    const onAbort = vi.fn()
    global.fetch = vi.fn().mockImplementation(async (input) => {
      // Listen for abort event and reject when it fires
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
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const f = createClient({ hooks: { onAbort } })
    await expect(
      f('https://example.com', { signal: controller.signal })
    ).rejects.toThrow()
    expect(onAbort).toHaveBeenCalled()
  })

  it('calls onCircuitOpen hook when circuit breaker is open', async () => {
    const onCircuitOpen = vi.fn()
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 1, reset: 50 },
      hooks: { onCircuitOpen },
    })
    await expect(f('https://example.com')).rejects.toThrow('fail')
    await expect(f('https://example.com')).rejects.toThrow('Circuit is open')
    expect(onCircuitOpen).toHaveBeenCalled()
  })

  it('calls transformRequest and transformResponse hooks', async () => {
    const transformRequest = vi.fn(async (req: Request) => {
      // Add a custom header
      const newReq = new Request(req, {
        headers: { ...Object.fromEntries(req.headers), 'x-test': '1' },
      })
      return newReq
    })
    const transformResponse = vi.fn(async (res: Response, _req: Request) => {
      // Change the response body
      const text = await res.text()
      return new Response(text + '-transformed', { status: res.status })
    })

    global.fetch = vi.fn().mockImplementation(async (input) => {
      // input is a Request object
      expect(input instanceof Request).toBe(true)
      expect(input.headers.get('x-test')).toBe('1')
      return new Response('original', { status: 200 })
    })

    const f = createClient({ hooks: { transformRequest, transformResponse } })
    const res = await f('https://example.com')
    const body = await res.text()
    expect(transformRequest).toHaveBeenCalled()
    expect(transformResponse).toHaveBeenCalled()
    expect(body).toBe('original-transformed')
  })

  it('transformRequest signal is properly combined with other signals', async () => {
    // Create controllers for user signal and transformRequest signal
    const userController = new AbortController()
    const transformController = new AbortController()

    const transformRequest = vi.fn(async (req: Request) => {
      // Transform request and add a different signal
      return new Request(req, {
        signal: transformController.signal,
      })
    })

    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined

      return new Promise((_resolve, reject) => {
        if (signal && signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
        } else if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
        // Don't resolve - we'll abort before it completes
      })
    })

    const client = createClient({
      timeout: 10000, // Long timeout
      hooks: { transformRequest },
    })

    const requestPromise = client('https://example.com', {
      signal: userController.signal,
    })

    // Abort via the transformRequest signal - this should abort the request
    setTimeout(() => transformController.abort(), 10)

    await expect(requestPromise).rejects.toThrow('aborted')
    expect(transformRequest).toHaveBeenCalled()
  })

  it('user signal can still abort when transformRequest has signal', async () => {
    // Create controllers for user signal and transformRequest signal
    const userController = new AbortController()
    const transformController = new AbortController()

    const transformRequest = vi.fn(async (req: Request) => {
      // Transform request and add a different signal
      return new Request(req, {
        signal: transformController.signal,
      })
    })

    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined

      return new Promise((_resolve, reject) => {
        if (signal && signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
        } else if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
        // Don't resolve - we'll abort before it completes
      })
    })

    const client = createClient({
      timeout: 10000, // Long timeout
      hooks: { transformRequest },
    })

    const requestPromise = client('https://example.com', {
      signal: userController.signal,
    })

    // Abort via the user signal - this should abort the request
    setTimeout(() => userController.abort(), 10)

    await expect(requestPromise).rejects.toThrow('aborted')
    expect(transformRequest).toHaveBeenCalled()
  })
})
