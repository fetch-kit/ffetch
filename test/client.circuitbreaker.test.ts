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
    await expect(f('https://example.com')).rejects.toThrow('Circuit open')

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 220))

    // Next call should try again (and fail)
    await expect(f('https://example.com')).rejects.toThrow('fail')
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })
})
