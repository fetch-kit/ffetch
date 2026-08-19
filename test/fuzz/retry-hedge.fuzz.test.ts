import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError } from '../../src/error.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

type ResponseOutcome = {
  delay: number
  status: 200 | 429 | 500 | 503
}

const compositionScenarioArbitrary = fc
  .record({
    retries: fc.integer({ min: 0, max: 2 }),
    maxHedges: fc.integer({ min: 1, max: 2 }),
  })
  .chain((config) => {
    const budget = (config.retries + 1) * (config.maxHedges + 1)
    return fc.record({
      ...Object.fromEntries(
        Object.entries(config).map(([key, value]) => [key, fc.constant(value)])
      ),
      outcomes: fc.array(
        fc.record({
          delay: fc.integer({ min: 0, max: 20 }),
          status: fc.constantFrom(200, 429, 500, 503),
        }),
        { minLength: budget, maxLength: budget }
      ),
    }) as fc.Arbitrary<{
      retries: number
      maxHedges: number
      outcomes: ResponseOutcome[]
    }>
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('retry and hedge composition fuzzing', () => {
  it('selects an available success without exceeding the product budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        compositionScenarioArbitrary,
        async ({ retries, maxHedges, outcomes }) => {
          fc.pre(outcomes.some(({ status }) => status === 200))
          vi.useFakeTimers()

          let calls = 0
          const client = createClient({
            timeout: 0,
            retries,
            retryDelay: 1,
            plugins: [hedgePlugin({ delay: 1, maxHedges })],
            fetchHandler: async () => {
              const outcome = outcomes[calls++]
              await new Promise((resolve) => setTimeout(resolve, outcome.delay))
              return new Response(null, { status: outcome.status })
            },
          })

          const resultPromise = client('https://example.com/composed-winner')
          await vi.runAllTimersAsync()
          const response = await resultPromise

          expect(response.ok).toBe(true)
          expect(calls).toBeLessThanOrEqual((retries + 1) * (maxHedges + 1))
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('keeps attempts and hooks within their logical budgets', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        async (retries, maxHedges) => {
          vi.useFakeTimers()

          const onRetry = vi.fn()
          const onComplete = vi.fn()
          const onHedge = vi.fn()
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries,
            retryDelay: 0,
            hooks: { onRetry, onComplete },
            plugins: [hedgePlugin({ delay: 1, maxHedges, onHedge })],
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          const resultPromise = client('https://example.com/composed-budget')
          await vi.runAllTimersAsync()
          const response = await resultPromise
          const branches = maxHedges + 1

          expect(response.status).toBe(503)
          expect(calls).toBe((retries + 1) * branches)
          expect(onRetry).toHaveBeenCalledTimes(retries * branches)
          expect(onHedge).toHaveBeenCalledTimes(maxHedges)
          expect(onComplete).toHaveBeenCalledOnce()
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('stops every branch when the user aborts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 2 }),
        async (abortAt, retries, maxHedges) => {
          vi.useFakeTimers()

          const controller = new AbortController()
          const signals: AbortSignal[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries,
            retryDelay: 1,
            plugins: [hedgePlugin({ delay: 1, maxHedges })],
            fetchHandler: async (input) => {
              calls++
              const signal = (input as Request).signal
              signals.push(signal)
              return new Promise<Response>((_resolve, reject) => {
                const abort = () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            },
          })

          const resultPromise = client('https://example.com/composed-abort', {
            signal: controller.signal,
          })
          let error: unknown
          const observedResult = resultPromise.catch((caught) => {
            error = caught
          })
          setTimeout(() => controller.abort(), abortAt)
          await vi.runAllTimersAsync()
          await observedResult
          const callsAfterSettlement = calls
          await vi.runAllTimersAsync()

          expect(error).toBeInstanceOf(AbortError)
          expect(signals.every((signal) => signal.aborted)).toBe(true)
          expect(calls).toBe(callsAfterSettlement)
          expect(calls).toBeLessThanOrEqual((retries + 1) * (maxHedges + 1))
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('launches no retry or hedge after a winner settles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        async (winnerDelay, retries, maxHedges) => {
          vi.useFakeTimers()

          let calls = 0
          const client = createClient({
            timeout: 0,
            retries,
            retryDelay: 1,
            plugins: [hedgePlugin({ delay: 1, maxHedges })],
            fetchHandler: async (input) => {
              const attempt = calls++
              const signal = (input as Request).signal
              if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, winnerDelay))
                return new Response(null)
              }
              return new Promise<Response>((_resolve, reject) => {
                const abort = () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            },
          })

          const resultPromise = client('https://example.com/composed-stop')
          await vi.runAllTimersAsync()
          const response = await resultPromise
          const callsAtSettlement = calls
          await vi.runAllTimersAsync()

          expect(response.ok).toBe(true)
          expect(calls).toBe(callsAtSettlement)
          expect(calls).toBeLessThanOrEqual(maxHedges + 1)
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('preserves request bodies across every composed physical attempt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 2 }),
        async (body, retries, maxHedges) => {
          vi.useFakeTimers()

          const bodies: string[] = []
          const client = createClient({
            timeout: 0,
            retries,
            retryDelay: 0,
            plugins: [hedgePlugin({ delay: 1, maxHedges })],
            fetchHandler: async (input) => {
              bodies.push(await (input as Request).text())
              return new Response(null, { status: 503 })
            },
          })

          const resultPromise = client('https://example.com/composed-body', {
            method: 'PUT',
            body,
          })
          await vi.runAllTimersAsync()
          await resultPromise

          const budget = (retries + 1) * (maxHedges + 1)
          expect(bodies).toHaveLength(budget)
          expect(bodies).toEqual(Array(budget).fill(body))
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('does not report cancelled hedge losers as logical request errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 10 }),
        async (maxHedges, winnerDelay) => {
          vi.useFakeTimers()

          const onAbort = vi.fn()
          const onError = vi.fn()
          const onComplete = vi.fn()
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: 0,
            hooks: { onAbort, onError, onComplete },
            plugins: [hedgePlugin({ delay: 1, maxHedges })],
            fetchHandler: async (input) => {
              const attempt = calls++
              const signal = (input as Request).signal
              if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, winnerDelay))
                return new Response(null)
              }
              return new Promise<Response>((_resolve, reject) => {
                const abort = () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            },
          })

          const resultPromise = client('https://example.com/composed-hooks')
          await vi.runAllTimersAsync()
          const response = await resultPromise
          await Promise.resolve()

          expect(response.ok).toBe(true)
          expect(onAbort).not.toHaveBeenCalled()
          expect(onError).not.toHaveBeenCalled()
          expect(onComplete).toHaveBeenCalledOnce()
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })
})
