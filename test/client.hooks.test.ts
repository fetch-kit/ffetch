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
    global.fetch = vi.fn().mockImplementation(async (_url, { signal }) => {
      await new Promise((r) => setTimeout(r, 100))
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('ok')
    })
    const f = createClient({ timeout: 10, hooks: { onTimeout } })
    await expect(f('https://example.com')).rejects.toThrow()
    expect(onTimeout).toHaveBeenCalled()
  })

  it('calls onAbort hook on abort', async () => {
    const onAbort = vi.fn()
    global.fetch = vi.fn().mockImplementation(async (_url, { signal }) => {
      await new Promise((r) => setTimeout(r, 100))
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('ok')
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
    await expect(f('https://example.com')).rejects.toThrow('Circuit open')
    expect(onCircuitOpen).toHaveBeenCalled()
  })
})
