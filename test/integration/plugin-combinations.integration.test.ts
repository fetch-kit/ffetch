/**
 * Integration tests for plugin combinations using fetchHandler closures.
 *
 * Each test composes real ffetch plugins against a hand-rolled fetchHandler
 * that simulates specific server behaviors (latency, flakiness, rate-limiting,
 * etc.) so no actual HTTP server is needed.
 *
 * Plugin order reference:
 *   dedupe  (10) → outermost — collapses identical concurrent callers
 *   hedge   (15)             — races parallel attempts
 *   circuit (20) → innermost — gates on failure threshold
 *   baseDispatch             — retry loop then actual fetch
 *
 * circuit uses preRequest / onSuccess / onError (not wrapDispatch), so it
 * fires once per top-level call and sees the hedge winner's final response.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import { createClient } from '../../src/client.js'
import { CircuitOpenError } from '../../src/index.js'
import { bulkheadPlugin } from '../../src/plugins/bulkhead.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'
import { dedupePlugin } from '../../src/plugins/dedupe.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('hedge reduces tail latency', () => {
  it('second attempt wins when original is slower than the hedge delay', async () => {
    vi.useFakeTimers()

    let calls = 0
    const fetchHandler = vi.fn(async () => {
      const attempt = ++calls
      if (attempt === 1) {
        // Original is slow — 200 ms
        await new Promise((r) => setTimeout(r, 200))
      }
      return new Response(`attempt-${attempt}`, { status: 200 })
    })

    const client = createClient({
      fetchHandler,
      plugins: [hedgePlugin({ delay: 50 })],
    })

    const resultP = client('https://example.com/slow')

    // Advance past hedge delay but before original finishes
    await vi.advanceTimersByTimeAsync(60)

    // Hedge attempt (call 2) responds immediately; original still pending
    const result = await resultP

    // The hedge won
    expect(await result.text()).toBe('attempt-2')
    // Original was still in flight but aborted
    expect(calls).toBe(2)
  })
})

describe('hedge + 5xx non-winner', () => {
  it('uses hedge response when original returns 5xx', async () => {
    vi.useFakeTimers()

    let calls = 0
    const d = { resolve: (_: Response) => {} }
    const slow = new Promise<Response>((res) => {
      d.resolve = res
    })

    const fetchHandler = async () => {
      calls++
      if (calls === 1) return slow
      return new Response('ok', { status: 200 })
    }

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [hedgePlugin({ delay: 50 })],
    })

    const resultP = client('https://example.com/flaky')
    await vi.advanceTimersByTimeAsync(60)

    // Original resolves with 500 — non-winner
    d.resolve(new Response('error', { status: 500 }))

    const result = await resultP
    expect(result.status).toBe(200)
  })
})

describe('hedge + 429 non-winner', () => {
  it('uses hedge response when original is rate-limited', async () => {
    vi.useFakeTimers()

    let calls = 0
    const d = { resolve: (_: Response) => {} }
    const slow = new Promise<Response>((res) => {
      d.resolve = res
    })

    const fetchHandler = async () => {
      calls++
      if (calls === 1) return slow
      return new Response('ok', { status: 200 })
    }

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [hedgePlugin({ delay: 50 })],
    })

    const resultP = client('https://example.com/rate-limited')
    await vi.advanceTimersByTimeAsync(60)

    d.resolve(new Response('rate limited', { status: 429 }))

    const result = await resultP
    expect(result.status).toBe(200)
  })
})

describe('retries absorb transient failures', () => {
  it('succeeds on 3rd attempt when first two throw network errors', async () => {
    let calls = 0
    const fetchHandler = vi.fn(async () => {
      if (++calls < 3) throw new Error('transient')
      return new Response('ok', { status: 200 })
    })

    const client = createClient({ retries: 2, fetchHandler })

    const result = await client('https://example.com/flaky-transient')
    expect(result.status).toBe(200)
    expect(fetchHandler).toHaveBeenCalledTimes(3)
  })

  it('succeeds on 3rd attempt when first two return 500', async () => {
    let calls = 0
    const fetchHandler = vi.fn(async () => {
      if (++calls < 3) return new Response('err', { status: 500 })
      return new Response('ok', { status: 200 })
    })

    const client = createClient({ retries: 2, fetchHandler })

    const result = await client('https://example.com/flaky-500')
    expect(result.status).toBe(200)
    expect(fetchHandler).toHaveBeenCalledTimes(3)
  })
})

describe('retries exhaust + circuit', () => {
  it('circuit opens when retries are exhausted on network errors', async () => {
    const fetchHandler = vi.fn(async () => {
      throw new Error('down')
    })

    const client = createClient({
      retries: 1, // 2 total attempts per call
      fetchHandler,
      plugins: [circuitPlugin({ threshold: 1, reset: 5000 })],
    })

    // First call: retries exhaust → RetryLimitError → circuit opens (threshold=1)
    // onError throws CircuitOpenError when it opens the circuit
    await expect(client('https://example.com/retries-circuit')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)

    // Second call: preRequest sees open circuit → immediate CircuitOpenError, no fetch
    await expect(client('https://example.com/retries-circuit')).rejects.toThrow(
      CircuitOpenError
    )
    expect(fetchHandler).toHaveBeenCalledTimes(2) // only from first call's 2 attempts
  })
})

describe('dedupe + hedge: bounded fetch count', () => {
  it('collapses N callers + hedges into at most 1 + maxHedges fetches', async () => {
    vi.useFakeTimers()

    let calls = 0
    const resolvers: Array<(r: Response) => void> = []

    const fetchHandler = vi.fn(async () => {
      calls++
      return new Promise<Response>((res) => resolvers.push(res))
    })

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [dedupePlugin(), hedgePlugin({ delay: 50, maxHedges: 1 })],
    })

    // 5 concurrent identical requests
    const promises = Array.from({ length: 5 }, () =>
      client('https://example.com/hot-path')
    )

    // Advance past hedge delay → hedge fires 1 extra attempt
    await vi.advanceTimersByTimeAsync(60)

    // Resolve all in-flight fetches
    const res = new Response('ok', { status: 200 })
    resolvers.forEach((resolve) => resolve(res))

    const results = await Promise.all(promises)
    expect(results.every((r) => r.status === 200)).toBe(true)

    // Dedupe → 1 active; hedge → +1; total ≤ 2 regardless of 5 callers
    expect(calls).toBeLessThanOrEqual(2)
  })
})

describe('bulkhead combinations', () => {
  it('bulkhead + dedupe still sends a single fetch for concurrent identical callers', async () => {
    const resolvers: Array<(r: Response) => void> = []
    const fetchHandler = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    )

    const client = createClient({
      retries: 0,
      fetchHandler,
      // Make dedupe outer (order 10) and bulkhead inner so duplicate callers
      // collapse before acquiring bulkhead slots.
      plugins: [
        dedupePlugin(),
        bulkheadPlugin({ maxConcurrent: 1, order: 15 }),
      ],
    })

    const p1 = client('https://example.com/same')
    const p2 = client('https://example.com/same')
    const p3 = client('https://example.com/same')

    await vi.waitFor(() => {
      expect(fetchHandler).toHaveBeenCalledTimes(1)
    })

    resolvers[0](new Response('ok', { status: 200 }))
    const all = await Promise.all([p1, p2, p3])

    expect(all.every((r) => r.status === 200)).toBe(true)
    expect(fetchHandler).toHaveBeenCalledTimes(1)
  })

  it('bulkhead + circuit opens after consecutive failing requests', async () => {
    const fetchHandler = vi.fn(async () => new Response('err', { status: 500 }))

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [
        bulkheadPlugin({ maxConcurrent: 1 }),
        circuitPlugin({ threshold: 2, reset: 5000 }),
      ],
    })

    await client('https://example.com/bulkhead-circuit-1')
    await expect(
      client('https://example.com/bulkhead-circuit-2')
    ).rejects.toThrow(CircuitOpenError)

    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      true
    )
  })
})

describe('circuit sees hedge winner, not losers', () => {
  it('circuit stays healthy when hedge wins with a 200 after a 500 first attempt', async () => {
    vi.useFakeTimers()

    let calls = 0
    const d = { resolve: (_: Response) => {} }
    const slow = new Promise<Response>((res) => {
      d.resolve = res
    })

    const fetchHandler = async () => {
      calls++
      if (calls === 1) return slow
      return new Response('ok', { status: 200 })
    }

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [
        hedgePlugin({ delay: 50 }),
        circuitPlugin({ threshold: 1, reset: 5000 }),
      ],
    })

    const resultP = client('https://example.com/hedge-circuit')
    await vi.advanceTimersByTimeAsync(60)

    // Original is slow 500; hedge already returned 200 and won
    d.resolve(new Response('error', { status: 500 }))

    const result = await resultP
    expect(result.status).toBe(200)
    // Circuit should NOT have opened because it saw the winner (200)
    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      false
    )
  })

  it('circuit DOES trip without hedge when the same server returns 500', async () => {
    const fetchHandler = async () => new Response('error', { status: 500 })

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [circuitPlugin({ threshold: 1, reset: 5000 })],
    })

    await expect(
      client('https://example.com/no-hedge-circuit')
    ).rejects.toThrow(CircuitOpenError)
    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      true
    )
  })
})

describe('full stack: dedupe + hedge + circuit + retries', () => {
  it('handles a flaky server and returns a successful response', async () => {
    let calls = 0
    // Fail the first 2 attempts then succeed
    const fetchHandler = vi.fn(async () => {
      if (++calls <= 2) return new Response('err', { status: 500 })
      return new Response('ok', { status: 200 })
    })

    const client = createClient({
      retries: 2,
      fetchHandler,
      plugins: [
        dedupePlugin(),
        hedgePlugin({ delay: 200 }), // delay longer than retries, so hedge doesn't race here
        circuitPlugin({ threshold: 10, reset: 5000 }),
      ],
    })

    const result = await client('https://example.com/full-stack')
    expect(result.status).toBe(200)
    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      false
    )
  })

  it('circuit opens after sustained failures even through retries', async () => {
    const fetchHandler = vi.fn(async () => new Response('err', { status: 500 }))

    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [dedupePlugin(), circuitPlugin({ threshold: 2, reset: 5000 })],
    })

    // First call → 500 → circuit.failures = 1
    await client('https://example.com/sustained-1')
    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      false
    )

    // Second call → 500 → circuit.failures = 2 >= threshold → opens
    await expect(client('https://example.com/sustained-2')).rejects.toThrow(
      CircuitOpenError
    )
    expect((client as unknown as { circuitOpen: boolean }).circuitOpen).toBe(
      true
    )

    // Third call blocked immediately
    await expect(client('https://example.com/sustained-3')).rejects.toThrow(
      CircuitOpenError
    )
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })
})
