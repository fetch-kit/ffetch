import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginDispatch, PluginRequestContext } from '../../src/plugins.js'
import { hedgePlugin } from '../../src/plugins/hedge.js'

type Outcome = {
  delay: number
  status: 200 | 429 | 500 | 503
}

const outcomeArbitrary = fc.record({
  delay: fc.integer({ min: 0, max: 20 }),
  status: fc.constantFrom(200, 429, 500, 503),
})

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
})
