import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError, BulkheadFullError, TimeoutError } from '../../src/error.js'
import { bulkheadPlugin } from '../../src/plugins/bulkhead.js'

type BulkheadClientState = {
  activeCount: number
  queueDepth: number
}

type Deferred = {
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

const observe = <T>(promise: Promise<T>): Promise<T | unknown> =>
  promise.catch((error: unknown) => error)

const flushMicrotasks = async () => {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('bulkhead plugin fuzzing', () => {
  it('bounds concurrency and queue depth while preserving FIFO admission', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 16 }),
        async (maxConcurrent, maxQueue, total) => {
          const deferreds: Deferred[] = []
          const dispatchOrder: number[] = []
          let physicalActive = 0
          let maximumPhysicalActive = 0
          const onReject = vi.fn()

          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [bulkheadPlugin({ maxConcurrent, maxQueue, onReject })],
            fetchHandler: async (input) => {
              const index = Number(
                new URL((input as Request).url).pathname.slice(1)
              )
              dispatchOrder.push(index)
              physicalActive++
              maximumPhysicalActive = Math.max(
                maximumPhysicalActive,
                physicalActive
              )
              try {
                return await new Promise<Response>((resolve, reject) => {
                  deferreds.push({ resolve, reject })
                })
              } finally {
                physicalActive--
              }
            },
          }) as BulkheadClientState & ReturnType<typeof createClient>

          const requests = Array.from({ length: total }, (_, index) =>
            client(`https://example.com/${index}`)
          )
          const observed = requests.map(observe)
          const accepted = Math.min(total, maxConcurrent + maxQueue)
          const initiallyActive = Math.min(total, maxConcurrent)
          const queued = Math.min(Math.max(total - maxConcurrent, 0), maxQueue)

          await flushMicrotasks()
          expect(deferreds).toHaveLength(initiallyActive)
          expect(client.activeCount).toBe(initiallyActive)
          expect(client.queueDepth).toBe(queued)
          expect(onReject).toHaveBeenCalledTimes(total - accepted)

          for (let index = 0; index < accepted; index++) {
            deferreds[index].resolve(new Response(String(index)))
            await observed[index]
            const nextExpected = Math.min(accepted, index + maxConcurrent + 1)
            expect(deferreds.length).toBeGreaterThanOrEqual(nextExpected)
          }

          const results = await Promise.all(observed)

          expect(dispatchOrder).toEqual(
            Array.from({ length: accepted }, (_, index) => index)
          )
          expect(maximumPhysicalActive).toBeLessThanOrEqual(maxConcurrent)
          expect(
            results
              .slice(accepted)
              .every((result) => result instanceof BulkheadFullError)
          ).toBe(true)
          expect(client.activeCount).toBe(0)
          expect(client.queueDepth).toBe(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('releases every slot after arbitrary success and failure outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        async (maxConcurrent, succeeds) => {
          const deferreds: Deferred[] = []
          let physicalActive = 0
          let maximumPhysicalActive = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [bulkheadPlugin({ maxConcurrent })],
            fetchHandler: async () => {
              physicalActive++
              maximumPhysicalActive = Math.max(
                maximumPhysicalActive,
                physicalActive
              )
              try {
                return await new Promise<Response>((resolve, reject) => {
                  deferreds.push({ resolve, reject })
                })
              } finally {
                physicalActive--
              }
            },
          }) as BulkheadClientState & ReturnType<typeof createClient>

          const observed = succeeds.map((_, index) =>
            observe(client(`https://example.com/outcome-${index}`))
          )
          await flushMicrotasks()
          expect(deferreds).toHaveLength(
            Math.min(maxConcurrent, succeeds.length)
          )

          for (let index = 0; index < succeeds.length; index++) {
            if (succeeds[index]) {
              deferreds[index].resolve(new Response(null))
            } else {
              deferreds[index].reject(new Error(`failure-${index}`))
            }
            await observed[index]
            const nextExpected = Math.min(
              succeeds.length,
              index + maxConcurrent + 1
            )
            expect(deferreds.length).toBeGreaterThanOrEqual(nextExpected)
          }

          await Promise.all(observed)

          expect(maximumPhysicalActive).toBeLessThanOrEqual(maxConcurrent)
          expect(client.activeCount).toBe(0)
          expect(client.queueDepth).toBe(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('removes arbitrary caller-aborted entries without disturbing FIFO order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        async (maxConcurrent, abortMask) => {
          const total = maxConcurrent + abortMask.length
          const deferreds: Deferred[] = []
          const dispatchOrder: number[] = []
          const controllers = Array.from(
            { length: total },
            () => new AbortController()
          )
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [bulkheadPlugin({ maxConcurrent })],
            fetchHandler: async (input) => {
              const index = Number(
                new URL((input as Request).url).pathname.slice(1)
              )
              dispatchOrder.push(index)
              return new Promise<Response>((resolve, reject) => {
                deferreds.push({ resolve, reject })
              })
            },
          }) as BulkheadClientState & ReturnType<typeof createClient>

          const requests = controllers.map((controller, index) =>
            client(`https://example.com/${index}`, {
              signal: controller.signal,
            })
          )
          const observed = requests.map(observe)

          await flushMicrotasks()
          expect(deferreds).toHaveLength(maxConcurrent)
          expect(client.queueDepth).toBe(abortMask.length)

          abortMask.forEach((shouldAbort, queuedIndex) => {
            if (shouldAbort) {
              controllers[maxConcurrent + queuedIndex].abort()
            }
          })

          const remainingQueued = abortMask.filter((value) => !value).length
          await flushMicrotasks()
          expect(client.queueDepth).toBe(remainingQueued)

          const expectedDispatch = [
            ...Array.from({ length: maxConcurrent }, (_, index) => index),
            ...abortMask.flatMap((aborted, index) =>
              aborted ? [] : [maxConcurrent + index]
            ),
          ]

          for (let index = 0; index < expectedDispatch.length; index++) {
            deferreds[index].resolve(new Response(null))
            await observed[expectedDispatch[index]]
            const nextExpected = Math.min(
              expectedDispatch.length,
              index + maxConcurrent + 1
            )
            expect(deferreds.length).toBeGreaterThanOrEqual(nextExpected)
          }

          const results = await Promise.all(observed)

          abortMask.forEach((aborted, index) => {
            if (aborted) {
              expect(results[maxConcurrent + index]).toBeInstanceOf(AbortError)
            }
          })
          expect(dispatchOrder).toEqual(expectedDispatch)
          expect(client.activeCount).toBe(0)
          expect(client.queueDepth).toBe(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('expires a queued request at its overall timeout without waiting for a slot', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000 }), async (timeout) => {
        const originalTimeout = AbortSignal.timeout
        const timeoutController = new AbortController()
        AbortSignal.timeout = vi.fn(
          (_milliseconds: number) => timeoutController.signal
        ) as typeof AbortSignal.timeout
        const deferreds: Deferred[] = []
        let calls = 0
        const client = createClient({
          timeout: 0,
          retries: 0,
          plugins: [bulkheadPlugin({ maxConcurrent: 1 })],
          fetchHandler: async () => {
            calls++
            return new Promise<Response>((resolve, reject) => {
              deferreds.push({ resolve, reject })
            })
          },
        }) as BulkheadClientState & ReturnType<typeof createClient>

        const active = client('https://example.com/active')
        const queued = client('https://example.com/queued', { timeout })
        const observedQueued = observe(queued)

        await flushMicrotasks()
        expect(calls).toBe(1)
        expect(client.queueDepth).toBe(1)

        timeoutController.abort(new DOMException('Timed out', 'TimeoutError'))
        await flushMicrotasks()
        const depthAtDeadline = client.queueDepth
        const callsAtDeadline = calls

        deferreds[0].resolve(new Response(null))
        await active
        const queuedResult = await observedQueued
        AbortSignal.timeout = originalTimeout

        expect(depthAtDeadline).toBe(0)
        expect(callsAtDeadline).toBe(1)
        expect(queuedResult).toBeInstanceOf(TimeoutError)
        expect(client.activeCount).toBe(0)
        expect(client.queueDepth).toBe(0)
      }),
      { numRuns: 300 }
    )
  })

  it('abortAll cancels active and queued requests without dispatching the queue', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 12 }),
        async (maxConcurrent, queuedCount) => {
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [bulkheadPlugin({ maxConcurrent })],
            fetchHandler: async (input) => {
              calls++
              const signal = (input as Request).signal
              return new Promise<Response>((_resolve, reject) => {
                const abort = () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            },
          }) as BulkheadClientState & ReturnType<typeof createClient>

          const observed = Array.from(
            { length: maxConcurrent + queuedCount },
            (_, index) => observe(client(`https://example.com/abort-${index}`))
          )

          await flushMicrotasks()
          expect(calls).toBe(maxConcurrent)
          expect(client.queueDepth).toBe(queuedCount)

          client.abortAll()
          const results = await Promise.all(observed)

          expect(results.every((result) => result instanceof AbortError)).toBe(
            true
          )
          expect(calls).toBe(maxConcurrent)
          expect(client.activeCount).toBe(0)
          expect(client.queueDepth).toBe(0)
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 300 }
    )
  })
})
