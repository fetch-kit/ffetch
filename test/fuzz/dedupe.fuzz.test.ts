import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError, RetryLimitError } from '../../src/error.js'
import { dedupePlugin } from '../../src/plugins/dedupe.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

const observe = <T>(promise: Promise<T>): Promise<T | unknown> =>
  promise.catch((error: unknown) => error)

afterEach(() => {
  vi.useRealTimers()
})

describe('dedupe plugin fuzzing', () => {
  it('collapses identical bursts and gives every caller an independent body', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.string({ maxLength: 500 }),
        async (callers, body) => {
          const response = deferred<Response>()
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [dedupePlugin()],
            fetchHandler: async () => {
              calls++
              return response.promise
            },
          })

          const requests = Array.from({ length: callers }, () =>
            client('https://example.com/shared')
          )
          await flushMicrotasks()
          expect(calls).toBe(1)

          response.resolve(new Response(body))
          const responses = await Promise.all(requests)
          const bodies = await Promise.all(
            responses.map((result) => result.text())
          )

          expect(bodies).toEqual(Array(callers).fill(body))
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('uses the documented method, URL, and body default identity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            method: fc.constantFrom('POST', 'PUT', 'PATCH'),
            path: fc.integer({ min: 0, max: 4 }),
            body: fc.string({ maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        async (descriptions) => {
          const physical: Deferred<Response>[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [dedupePlugin()],
            fetchHandler: async () => {
              calls++
              const next = deferred<Response>()
              physical.push(next)
              return next.promise
            },
          })

          const requests = descriptions.map(({ method, path, body }) =>
            client(`https://example.com/${path}`, { method, body })
          )
          await flushMicrotasks()

          const uniqueKeys = new Set(
            descriptions.map(
              ({ method, path, body }) =>
                `${method}|https://example.com/${path}|${body}`
            )
          )
          expect(calls).toBe(uniqueKeys.size)

          physical.forEach((entry) => entry.resolve(new Response(null)))
          await Promise.all(requests)
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('obeys a custom hash function exactly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.boolean(),
        async (callers, collapse) => {
          const physical: Deferred<Response>[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [
              dedupePlugin({ hashFn: () => (collapse ? 'shared' : undefined) }),
            ],
            fetchHandler: async () => {
              calls++
              const next = deferred<Response>()
              physical.push(next)
              return next.promise
            },
          })

          const requests = Array.from({ length: callers }, (_, index) =>
            client('https://example.com/custom', {
              method: 'POST',
              body: String(index),
            })
          )
          await flushMicrotasks()

          expect(calls).toBe(collapse ? 1 : callers)
          physical.forEach((entry) => entry.resolve(new Response(null)))
          await Promise.all(requests)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('fans one physical failure out to every deduplicated caller', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (callers) => {
        const failure = deferred<Response>()
        let calls = 0
        const client = createClient({
          timeout: 0,
          retries: 0,
          plugins: [dedupePlugin()],
          fetchHandler: async () => {
            calls++
            return failure.promise
          },
        })

        const observed = Array.from({ length: callers }, () =>
          observe(client('https://example.com/failure'))
        )
        await flushMicrotasks()
        failure.reject(new Error('generated failure'))
        const results = await Promise.all(observed)

        expect(calls).toBe(1)
        expect(
          results.every((result) => result instanceof RetryLimitError)
        ).toBe(true)
        expect(client.pendingRequests).toHaveLength(0)
      }),
      { numRuns: 300 }
    )
  })

  it('does not collapse Request inputs whose documented body identity differs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 100 }),
        fc.string({ maxLength: 100 }),
        async (firstBody, secondBody) => {
          fc.pre(firstBody !== secondBody)

          const physical: Deferred<Response>[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [dedupePlugin()],
            fetchHandler: async () => {
              calls++
              const next = deferred<Response>()
              physical.push(next)
              return next.promise
            },
          })

          const first = client(
            new Request('https://example.com/request-body', {
              method: 'POST',
              body: firstBody,
            })
          )
          const second = client(
            new Request('https://example.com/request-body', {
              method: 'POST',
              body: secondBody,
            })
          )
          await flushMicrotasks()
          const callsBeforeSettlement = calls

          physical.forEach((entry) => entry.resolve(new Response(null)))
          await Promise.all([first, second])

          expect(callsBeforeSettlement).toBe(2)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('lets an aborted waiter stop waiting without cancelling the shared request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 19 }),
        async (callers, generatedIndex) => {
          const waiterIndex = 1 + (generatedIndex % (callers - 1))
          const response = deferred<Response>()
          const controllers = Array.from(
            { length: callers },
            () => new AbortController()
          )
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [dedupePlugin()],
            fetchHandler: async () => {
              calls++
              return response.promise
            },
          })

          let waiterSettled = false
          const requests = controllers.map((controller) =>
            observe(
              client('https://example.com/waiter-abort', {
                signal: controller.signal,
              })
            )
          )
          void requests[waiterIndex].then(() => {
            waiterSettled = true
          })
          await flushMicrotasks()

          controllers[waiterIndex].abort()
          await new Promise((resolve) => setTimeout(resolve, 0))
          const settledAtAbort = waiterSettled

          response.resolve(new Response(null))
          const results = await Promise.all(requests)

          expect(calls).toBe(1)
          expect(settledAtAbort).toBe(true)
          expect(results[waiterIndex]).toBeInstanceOf(AbortError)
          expect(
            results.every(
              (result, index) =>
                index === waiterIndex || result instanceof Response
            )
          ).toBe(true)
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('prevents stale completion from deleting a newer TTL replacement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        async (ttl, generatedSweepInterval) => {
          vi.useFakeTimers()
          const sweepInterval = Math.min(ttl, generatedSweepInterval)
          const physical: Deferred<Response>[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            plugins: [dedupePlugin({ ttl, sweepInterval })],
            fetchHandler: async () => {
              calls++
              const next = deferred<Response>()
              physical.push(next)
              return next.promise
            },
          })

          const stale = client('https://example.com/ttl-race')
          await vi.advanceTimersByTimeAsync(ttl + sweepInterval)
          const replacement = client('https://example.com/ttl-race')
          await vi.advanceTimersByTimeAsync(0)
          expect(calls).toBe(2)

          physical[0].resolve(new Response('stale'))
          await stale

          const replacementWaiter = client('https://example.com/ttl-race')
          await vi.advanceTimersByTimeAsync(0)
          const callsBeforeReplacementSettles = calls

          physical[1].resolve(new Response('replacement'))
          const [replacementResponse, waiterResponse] = await Promise.all([
            replacement,
            replacementWaiter,
          ])

          expect(callsBeforeReplacementSettles).toBe(2)
          expect(await replacementResponse.text()).toBe('replacement')
          expect(await waiterResponse.text()).toBe('replacement')
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)
          vi.useRealTimers()
        }
      ),
      { numRuns: 300 }
    )
  })
})
