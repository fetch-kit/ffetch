import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { CircuitOpenError, RetryLimitError } from '../../src/error.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('circuit plugin fuzzing', () => {
  it('opens exactly at the configured consecutive HTTP failure threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.constantFrom(429, 500, 502, 503, 599),
        async (threshold, failureStatus) => {
          let calls = 0
          const client = createClient({
            retries: 0,
            plugins: [circuitPlugin({ threshold, reset: 1_000 })],
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: failureStatus })
            },
          })

          for (let attempt = 1; attempt < threshold; attempt++) {
            const response = await client(
              `https://example.com/circuit-threshold-${attempt}`
            )
            expect(response.status).toBe(failureStatus)
            expect(client.circuitOpen).toBe(false)
          }

          await expect(
            client('https://example.com/circuit-threshold-final')
          ).rejects.toBeInstanceOf(CircuitOpenError)
          expect(client.circuitOpen).toBe(true)
          expect(calls).toBe(threshold)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('resets consecutive failures whenever a non-failure response succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(200, 201, 204, 301, 400, 404),
        async (threshold, cycles, successStatus) => {
          const statuses = Array.from({ length: cycles }, () => [
            ...Array(threshold - 1).fill(503),
            successStatus,
          ]).flat()
          let calls = 0
          const client = createClient({
            retries: 0,
            plugins: [circuitPlugin({ threshold, reset: 1_000 })],
            fetchHandler: async () =>
              new Response(null, { status: statuses[calls++] }),
          })

          for (let index = 0; index < statuses.length; index++) {
            const response = await client(
              `https://example.com/circuit-reset-${index}`
            )
            expect(response.status).toBe(statuses[index])
            expect(client.circuitOpen).toBe(false)
          }

          expect(calls).toBe(statuses.length)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('rejects immediately while open without dispatching or queueing requests', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        async (blockedRequests) => {
          vi.useFakeTimers()

          const onCircuitOpen = vi.fn()
          let calls = 0
          const client = createClient({
            retries: 0,
            plugins: [
              circuitPlugin({
                threshold: 1,
                reset: 1_000,
                onCircuitOpen,
              }),
            ],
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          await expect(
            client('https://example.com/circuit-open')
          ).rejects.toBeInstanceOf(CircuitOpenError)

          const blocked = Array.from({ length: blockedRequests }, (_, index) =>
            client(`https://example.com/circuit-blocked-${index}`)
          )
          const results = await Promise.allSettled(blocked)

          expect(
            results.every(
              (result) =>
                result.status === 'rejected' &&
                result.reason instanceof CircuitOpenError
            )
          ).toBe(true)
          expect(calls).toBe(1)
          expect(onCircuitOpen).toHaveBeenCalledTimes(blockedRequests + 1)
          expect(
            onCircuitOpen.mock.calls
              .slice(1)
              .every(([event]) => event.reason.type === 'already-open')
          ).toBe(true)

          await vi.advanceTimersByTimeAsync(999)
          expect(calls).toBe(1)
          vi.useRealTimers()
        }
      ),
      { numRuns: 300 }
    )
  })

  it('admits every concurrent request after reset under the current two-state contract', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 1_000 }),
        async (concurrency, reset) => {
          vi.useFakeTimers()

          const onCircuitClose = vi.fn()
          let calls = 0
          let fail = true
          const client = createClient({
            retries: 0,
            plugins: [circuitPlugin({ threshold: 1, reset, onCircuitClose })],
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: fail ? 503 : 200 })
            },
          })

          await expect(
            client('https://example.com/circuit-open')
          ).rejects.toBeInstanceOf(CircuitOpenError)
          await vi.advanceTimersByTimeAsync(reset)
          fail = false

          const responses = await Promise.all(
            Array.from({ length: concurrency }, (_, index) =>
              client(`https://example.com/circuit-probe-${index}`)
            )
          )

          expect(responses.every((response) => response.ok)).toBe(true)
          expect(calls).toBe(concurrency + 1)
          expect(client.circuitOpen).toBe(false)
          expect(onCircuitClose).toHaveBeenCalledOnce()
          vi.useRealTimers()
        }
      ),
      { numRuns: 300 }
    )
  })

  it('reopens and starts a fresh reset window when a post-reset request fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000 }),
        fc.constantFrom(429, 500, 502, 503),
        async (reset, status) => {
          vi.useFakeTimers()

          let calls = 0
          const client = createClient({
            retries: 0,
            plugins: [circuitPlugin({ threshold: 1, reset })],
            fetchHandler: async () => {
              calls++
              return new Response(null, { status })
            },
          })

          await expect(
            client('https://example.com/circuit-open')
          ).rejects.toBeInstanceOf(CircuitOpenError)
          await vi.advanceTimersByTimeAsync(reset)
          await expect(
            client('https://example.com/circuit-failed-probe')
          ).rejects.toBeInstanceOf(CircuitOpenError)

          await vi.advanceTimersByTimeAsync(reset - 1)
          await expect(
            client('https://example.com/circuit-still-open')
          ).rejects.toBeInstanceOf(CircuitOpenError)
          expect(calls).toBe(2)
          expect(client.circuitOpen).toBe(true)
          vi.useRealTimers()
        }
      ),
      { numRuns: 300 }
    )
  })

  it('counts thrown transport failures using the same threshold', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (threshold) => {
        const transportError = new Error('generated transport failure')
        let calls = 0
        const client = createClient({
          retries: 0,
          plugins: [circuitPlugin({ threshold, reset: 1_000 })],
          fetchHandler: async () => {
            calls++
            throw transportError
          },
        })

        for (let attempt = 1; attempt < threshold; attempt++) {
          await expect(
            client(`https://example.com/circuit-network-${attempt}`)
          ).rejects.toMatchObject({
            name: RetryLimitError.name,
            message: transportError.message,
          })
          expect(client.circuitOpen).toBe(false)
        }

        await expect(
          client('https://example.com/circuit-network-final')
        ).rejects.toBeInstanceOf(CircuitOpenError)
        expect(client.circuitOpen).toBe(true)
        expect(calls).toBe(threshold)
      }),
      { numRuns: 500 }
    )
  })
})
