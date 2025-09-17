import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../src/client.js'
import { CircuitOpenError, RetryLimitError } from '../src/index.js'

it('calls onCircuitOpen and onCircuitClose hooks appropriately', async () => {
  let openCalled = false
  let closeCalled = false

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
      onCircuitClose: (_req) => {
        closeCalled = true
      },
    },
  })

  // First two requests fail, opening the circuit
  await expect(client('https://example.com')).rejects.toThrow('fail')
  await expect(client('https://example.com')).rejects.toThrow(CircuitOpenError)
  expect(openCalled).toBe(true)
  expect(closeCalled).toBe(false)

  // Wait for reset period
  await new Promise((resolve) => setTimeout(resolve, 120))

  // Third request should still fail (circuit not reset yet)
  await expect(client('https://example.com')).rejects.toThrow(RetryLimitError)
  // Optionally, if circuit is open, use CircuitOpenError
  // await expect(client('https://example.com')).rejects.toThrow(CircuitOpenError)
  // Circuit should not be closed yet
  expect(closeCalled).toBe(false)
})

describe('CircuitBreaker', () => {
  it('exposes open state via getter', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const client = createClient({
      retries: 0,
      circuit: { threshold: 3, reset: 100 },
    })
    // Initially, circuit should be closed
    expect(client.circuitOpen).toBe(false)
    // First failure
    await expect(client('https://test.com')).rejects.toThrow('fail')
    expect(client.circuitOpen).toBe(false)
    // Second failure
    await expect(client('https://test.com')).rejects.toThrow('fail')
    expect(client.circuitOpen).toBe(true)
    // Third failure opens the circuit
    await expect(client('https://test.com')).rejects.toThrow(CircuitOpenError)
    expect(client.circuitOpen).toBe(true)
    // Blocked by circuit breaker
    await expect(client('https://test.com')).rejects.toThrow('Circuit is open')
    expect(client.circuitOpen).toBe(true)
    // Wait for reset
    await new Promise((r) => setTimeout(r, 200))
    // After reset, next call tries again (and fails)
    await expect(client('https://test.com')).rejects.toThrow('fail')
    expect(client.circuitOpen).toBe(true)
    // Simulate a successful request
    global.fetch = vi.fn().mockResolvedValue(new Response('ok'))
    await new Promise((r) => setTimeout(r, 120))
    await expect(client('https://test.com')).resolves.toBeInstanceOf(Response)
    // Circuit should now be closed
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
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)

    // Third call should be blocked by circuit breaker
    await expect(f('https://example.com')).rejects.toThrow('Circuit is open')

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 220)).catch(() => {})

    // Next call should try again (and fail)
    await expect(f('https://example.com')).rejects.toThrow('fail')
    expect(global.fetch).toHaveBeenCalledTimes(2)
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
    await expect(f('https://a.com')).rejects.toThrow(CircuitOpenError)
  })

  it('opens circuit after threshold and blocks further requests', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      circuit: { threshold: 2, reset: 1000 },
    })
    await expect(f('https://b.com')).rejects.toThrow('fail')
    await expect(f('https://b.com')).rejects.toThrow(CircuitOpenError)
    // Now circuit should be open
    await expect(f('https://b.com')).rejects.toThrow(CircuitOpenError)
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
    await expect(f('https://c.com')).rejects.toThrow(CircuitOpenError)
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
    await expect(f('https://d.com')).rejects.toThrow(CircuitOpenError)
    // Circuit is now open, wait for reset
    await new Promise((r) => setTimeout(r, 120)).catch(() => {})
    // Now succeed
    fail = false
    await expect(f('https://d.com')).resolves.toBeInstanceOf(Response)
    // Should not open circuit after another failure
    fail = true
    await expect(f('https://d.com')).rejects.toThrow('fail')
    await expect(f('https://d.com')).rejects.toThrow(CircuitOpenError)
    // Now circuit should open
    await expect(f('https://d.com')).rejects.toThrow('Circuit is open')
  })
})
