import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginDispatch, PluginRequestContext } from '../../src/plugins.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

type Outcome = {
  delay: number
  status: 200 | 429 | 500 | 503
}

type MixedOutcome =
  | Outcome
  | {
      delay: number
      error: 'connection-reset' | 'socket-closed'
    }

const outcomeArbitrary = fc.record({
  delay: fc.integer({ min: 0, max: 20 }),
  status: fc.constantFrom(200, 429, 500, 503),
})

const mixedOutcomeArbitrary: fc.Arbitrary<MixedOutcome> = fc.oneof(
  fc.record({
    delay: fc.integer({ min: 10, max: 30 }),
    status: fc.constantFrom(200, 429, 500, 503),
  }),
  fc.record({
    delay: fc.integer({ min: 10, max: 30 }),
    error: fc.constantFrom('connection-reset', 'socket-closed'),
  })
)

function makeContext(): PluginRequestContext {
  return {
    request: new Request('https://example.com/fuzz'),
    init: {},
    state: {},
    metadata: {
      startedAt: Date.now(),
      timeoutMs: 5_000,
      signals: {},
      retry: {
        configuredRetries: 0,
        configuredDelay: 0,
        attempt: 0,
      },
    },
  }
}

function delayedResponse(outcome: Outcome): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(
      () => resolve(new Response(null, { status: outcome.status })),
      outcome.delay
    )
  })
}

function delayedMixedOutcome(outcome: MixedOutcome): Promise<Response> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if ('error' in outcome) {
        reject(new TypeError(outcome.error))
      } else {
        resolve(new Response(null, { status: outcome.status }))
      }
    }, outcome.delay)
  })
}

function responseDispatch(
  outcomes: Outcome[],
  signals?: AbortSignal[]
): { dispatch: PluginDispatch; calls: () => number } {
  let calls = 0
  return {
    dispatch: (ctx) => {
      const attempt = calls++
      signals?.push(ctx.request.signal)
      return delayedResponse(outcomes[attempt])
    },
    calls: () => calls,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('hedge policy fuzzing', () => {
  it('does not let a retryable response beat an in-flight success', async () => {
    await fc.assert(
      fc.asyncProperty(
        outcomeArbitrary,
        outcomeArbitrary,
        async (original, hedge) => {
          fc.pre(original.status === 200 || hedge.status === 200)

          vi.useFakeTimers()

          const outcomes = [original, hedge]
          let calls = 0
          const next: PluginDispatch = () => delayedResponse(outcomes[calls++])
          const dispatch = hedgePlugin({ delay: 1 }).wrapDispatch!(next)

          const resultPromise = dispatch(makeContext())
          await vi.runAllTimersAsync()
          const result = await resultPromise

          expect(result.ok).toBe(true)
          expect(calls).toBeLessThanOrEqual(2)

          vi.useRealTimers()
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('selects an available success across multiple hedges', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(outcomeArbitrary, { minLength: 2, maxLength: 4 }),
        async (outcomes) => {
          fc.pre(outcomes.some(({ status }) => status === 200))

          vi.useFakeTimers()

          const handler = responseDispatch(outcomes)
          const dispatch = hedgePlugin({
            delay: 1,
            maxHedges: outcomes.length - 1,
          }).wrapDispatch!(handler.dispatch)

          const resultPromise = dispatch(makeContext())
          await vi.runAllTimersAsync()
          const result = await resultPromise

          expect(result.ok).toBe(true)
          expect(handler.calls()).toBeLessThanOrEqual(outcomes.length)

          vi.useRealTimers()
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('never launches more than the configured attempt budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 20 }),
        async (maxHedges, responseDelay) => {
          vi.useFakeTimers()

          let calls = 0
          const next: PluginDispatch = async () => {
            calls++
            await new Promise((resolve) => setTimeout(resolve, responseDelay))
            return new Response(null, { status: 503 })
          }
          const dispatch = hedgePlugin({ delay: 1, maxHedges }).wrapDispatch!(
            next
          )

          const resultPromise = dispatch(makeContext())
          await vi.runAllTimersAsync()
          await resultPromise

          expect(calls).toBe(maxHedges + 1)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('selects success from a mixture of responses and transport errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(mixedOutcomeArbitrary, { minLength: 2, maxLength: 4 }),
        async (outcomes) => {
          fc.pre(
            outcomes.some(
              (outcome) => 'status' in outcome && outcome.status === 200
            )
          )

          vi.useFakeTimers()

          let calls = 0
          const next: PluginDispatch = () =>
            delayedMixedOutcome(outcomes[calls++])
          const dispatch = hedgePlugin({
            delay: 1,
            maxHedges: outcomes.length - 1,
          }).wrapDispatch!(next)

          const resultPromise = dispatch(makeContext())
          await vi.runAllTimersAsync()
          const result = await resultPromise

          expect(result.ok).toBe(true)
          expect(calls).toBeLessThanOrEqual(outcomes.length)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('cancels every in-flight loser and stops scheduling attempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 10 }),
        async (maxHedges, winnerDelay) => {
          vi.useFakeTimers()

          const signals: AbortSignal[] = []
          let calls = 0
          const next: PluginDispatch = (ctx) => {
            const attempt = calls++
            signals.push(ctx.request.signal)
            if (attempt === 0) {
              return new Promise((resolve) => {
                setTimeout(
                  () => resolve(new Response(null, { status: 200 })),
                  winnerDelay
                )
              })
            }
            return new Promise(() => {})
          }
          const dispatch = hedgePlugin({ delay: 1, maxHedges }).wrapDispatch!(
            next
          )

          const resultPromise = dispatch(makeContext())
          await vi.advanceTimersByTimeAsync(winnerDelay)
          const result = await resultPromise
          const callsAtSettlement = calls
          await vi.runAllTimersAsync()

          expect(result.ok).toBe(true)
          expect(signals[0].aborted).toBe(false)
          expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true)
          expect(calls).toBe(callsAtSettlement)
          expect(calls).toBeLessThanOrEqual(maxHedges + 1)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('propagates external abort and launches nothing afterwards', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 1, max: 4 }),
        async (abortAt, maxHedges) => {
          vi.useFakeTimers()

          const external = new AbortController()
          const signals: AbortSignal[] = []
          let calls = 0
          const next: PluginDispatch = (ctx) => {
            calls++
            signals.push(ctx.request.signal)
            return new Promise<Response>((_resolve, reject) => {
              const onAbort = () =>
                reject(new DOMException('Aborted', 'AbortError'))
              if (ctx.request.signal.aborted) onAbort()
              else
                ctx.request.signal.addEventListener('abort', onAbort, {
                  once: true,
                })
            })
          }
          const dispatch = hedgePlugin({ delay: 2, maxHedges }).wrapDispatch!(
            next
          )
          const context = makeContext()
          context.request = new Request(context.request, {
            signal: external.signal,
          })

          const resultPromise = dispatch(context)
          const assertion = expect(resultPromise).rejects.toMatchObject({
            name: 'AbortError',
          })
          setTimeout(() => external.abort(), abortAt)
          await vi.runAllTimersAsync()
          await assertion
          const callsAfterAbort = calls
          await vi.runAllTimersAsync()

          expect(signals.every((signal) => signal.aborted)).toBe(true)
          expect(calls).toBe(callsAfterAbort)
          expect(calls).toBeLessThanOrEqual(maxHedges + 1)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })
})
