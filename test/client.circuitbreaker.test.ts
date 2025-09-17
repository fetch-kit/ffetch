it('calls onCircuitOpen and onCircuitClose hooks appropriately', async () => {
  let openCalled = false
  let closeCalled = false
  let closeRequest: Request | undefined

  // Simulate fetch: fail twice, then succeed
  let callCount = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    callCount++
    if (callCount < 3) throw new Error('fail')
    return new Response('ok')
  })

  const client = createClient({
    retries: 0,
    circuit: { threshold: 2, reset: 100 },
    hooks: {
      onCircuitOpen: () => {
        openCalled = true
      },
      onCircuitClose: (req) => {
        closeCalled = true
        closeRequest = req
      },
    },
  })

  // First two requests fail, opening the circuit
  await expect(client('https://example.com')).rejects.toThrow('fail')
  await expect(client('https://example.com')).rejects.toThrow('fail')
  expect(openCalled).toBe(true)
  expect(closeCalled).toBe(false)

  // Wait for reset period
  await new Promise((resolve) => setTimeout(resolve, 120))

  // Third request succeeds, closing the circuit
  await expect(client('https://example.com')).resolves.toBeInstanceOf(Response)
  expect(closeCalled).toBe(true)
  expect(closeRequest).toBeInstanceOf(Request)
})
import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'

describe('CircuitBreaker', () => {
  it('exposes open state via getter', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const client = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 100 },
    })
    // First two failures should open the circuit
    await expect(client('https://test.com')).rejects.toThrow('fail')
    await expect(client('https://test.com')).rejects.toThrow('fail')
    // Circuit should now be open
    expect(client.circuitOpen).toBe(true)
    // Third call should be blocked by circuit breaker
    await expect(client('https://test.com')).rejects.toThrow('Circuit is open')
    // Wait for reset (increase to ensure it's past the reset period)
    await new Promise((r) => setTimeout(r, 200))
    // After reset, the next call should try again (and fail)
    await expect(client('https://test.com')).rejects.toThrow('fail')
    // Circuit is still open after another failure
    expect(client.circuitOpen).toBe(true)
    // Now simulate a successful request
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'))
    await new Promise((r) => setTimeout(r, 120)) // Ensure reset period is fully elapsed
    // Now the circuit should allow the request and close
    await expect(client('https://test.com')).resolves.toBeInstanceOf(Response)
    expect(client.circuitOpen).toBe(false)
  })
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
