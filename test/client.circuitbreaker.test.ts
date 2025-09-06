import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'

describe('CircuitBreaker', () => {
  it('blocks requests after threshold and resets after timeout', async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('fail')
    })

    const f = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 200 },
    })

    // First two calls fail and increment failures
    await expect(f('https://example.com')).rejects.toThrow('fail')
    await expect(f('https://example.com')).rejects.toThrow('fail')

    // Third call should be blocked by circuit breaker
    await expect(f('https://example.com')).rejects.toThrow('Circuit is open')

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 220)).catch(() => {})

    // Next call should try again (and fail)
    await expect(f('https://example.com')).rejects.toThrow('fail')
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not open circuit if threshold not reached', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 3, reset: 100 },
    })
    // Only 2 failures, threshold is 3
    await expect(f('https://a.com')).rejects.toThrow('fail')
    await expect(f('https://a.com')).rejects.toThrow('fail')
    // Should not be open yet
    await expect(f('https://a.com')).rejects.toThrow('fail')
  })

  it('opens circuit after threshold and blocks further requests', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 1000 },
    })
    await expect(f('https://b.com')).rejects.toThrow('fail')
    await expect(f('https://b.com')).rejects.toThrow('fail')
    // Now circuit should be open
    await expect(f('https://b.com')).rejects.toThrow('Circuit is open')
  })

  it('closes circuit after reset and allows requests again', async () => {
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      throw new Error('fail')
    })
    const f = createClient({
      retries: 0,
      circuit: { threshold: 1, reset: 100 },
    })
    await expect(f('https://c.com')).rejects.toThrow('fail')
    // Circuit opens
    await expect(f('https://c.com')).rejects.toThrow('Circuit is open')
    // Wait for reset
    await new Promise((r) => setTimeout(r, 120)).catch(() => {})
    // Should try again
    await expect(f('https://c.com')).rejects.toThrow('fail')
    expect(callCount).toBe(2)
  })

  it('resets failure count after a successful request', async () => {
    let fail = true
    global.fetch = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('fail')
      return new Response('ok')
    })
    const f = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 100 },
    })
    // Two failures
    await expect(f('https://d.com')).rejects.toThrow('fail')
    await expect(f('https://d.com')).rejects.toThrow('fail')
    // Circuit is now open, wait for reset
    await new Promise((r) => setTimeout(r, 120)).catch(() => {})
    // Now succeed
    fail = false
    await expect(f('https://d.com')).resolves.toBeInstanceOf(Response)
    // Should not open circuit after another failure
    fail = true
    await expect(f('https://d.com')).rejects.toThrow('fail')
    await expect(f('https://d.com')).rejects.toThrow('fail')
    // Now circuit should open
    await expect(f('https://d.com')).rejects.toThrow('Circuit is open')
  })
})
