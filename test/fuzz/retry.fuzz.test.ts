import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import { AbortError, TimeoutError } from '../../src/error.js'
import { runRetrySequence } from '../../src/internals/retry-execution.js'
import type { PluginRetryMetadata } from '../../src/plugins.js'
import { defaultDelay } from '../../src/retry.js'
import { shouldRetry } from '../../src/should-retry.js'

const statusArbitrary = fc.constantFrom(200, 204, 400, 404, 429, 500, 503)

type RetryOutcome =
  | { kind: 'response'; status: 200 | 400 | 429 | 500 | 503 }
  | { kind: 'error'; message: 'connection-reset' | 'failed-to-fetch' }

const retryOutcomeArbitrary: fc.Arbitrary<RetryOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant('response' as const),
    status: fc.constantFrom(200, 400, 429, 500, 503),
  }),
  fc.record({
    kind: fc.constant('error' as const),
    message: fc.constantFrom('connection-reset', 'failed-to-fetch'),
  })
)

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** The retry metadata a request starts with, as the pipeline allocates it. */
function retryMetadata(
  configuredRetries: number,
  configuredDelay: number
): PluginRetryMetadata {
  return { configuredRetries, configuredDelay, attempt: 0 }
}

function expectedResponseRun(statuses: number[], retries: number) {
  const budget = retries + 1
  for (let attempt = 0; attempt < budget; attempt++) {
    const status = statuses[Math.min(attempt, statuses.length - 1)]
    if (!isRetryable(status) || attempt === budget - 1) {
      return { attempts: attempt + 1, status }
    }
  }
  throw new Error('unreachable')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('retry policy fuzzing', () => {
  it('uses the default retry decision when no callback is supplied', async () => {
    let calls = 0
    const response = await runRetrySequence({
      attempt: async () => {
        calls++
        return new Response(null, { status: 200 })
      },
      retries: 1,
      delay: 0,
      request: new Request('https://example.com/default-retry-decision'),
      metadata: retryMetadata(1, 0),
    })

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('waits out the delay between attempts when nothing cancels the request', async () => {
    vi.useFakeTimers()

    let calls = 0
    const sequence = runRetrySequence({
      attempt: async () => {
        calls++
        return new Response(null, { status: calls === 1 ? 503 : 200 })
      },
      retries: 1,
      delay: 50,
      decide: shouldRetry,
      request: new Request('https://example.com/retry-delay'),
      metadata: retryMetadata(1, 50),
    })

    await vi.advanceTimersByTimeAsync(49)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect((await sequence).status).toBe(200)
    expect(calls).toBe(2)
  })

  it('obeys the attempt budget and stops at the first terminal response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(statusArbitrary, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 6 }),
        async (statuses, retries) => {
          let calls = 0
          const expected = expectedResponseRun(statuses, retries)
          const request = new Request('https://example.com/retry-fuzz')

          const result = await runRetrySequence({
            attempt: async () => {
              const status = statuses[Math.min(calls, statuses.length - 1)]
              calls++
              return new Response(null, { status })
            },
            retries,
            delay: 0,
            decide: shouldRetry,
            request,
            metadata: retryMetadata(retries, 0),
          })

          expect(result.status).toBe(expected.status)
          expect(calls).toBe(expected.attempts)
          expect(calls).toBeLessThanOrEqual(retries + 1)
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('reports retry and completion hooks consistently with physical attempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(statusArbitrary, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 6 }),
        async (statuses, retries) => {
          const onRetry = vi.fn()
          const onComplete = vi.fn()
          let calls = 0
          const expected = expectedResponseRun(statuses, retries)
          const client = createClient({
            retries,
            retryDelay: 0,
            hooks: { onRetry, onComplete },
            fetchHandler: async () => {
              const status = statuses[Math.min(calls, statuses.length - 1)]
              calls++
              return new Response(null, { status })
            },
          })

          const result = await client('https://example.com/retry-hooks')

          expect(result.status).toBe(expected.status)
          expect(calls).toBe(expected.attempts)
          expect(onRetry).toHaveBeenCalledTimes(expected.attempts - 1)
          expect(onComplete).toHaveBeenCalledOnce()
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('applies the same attempt budget to responses and transport errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(retryOutcomeArbitrary, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 6 }),
        async (outcomes, retries) => {
          let calls = 0
          const budget = retries + 1
          const request = new Request('https://example.com/retry-errors')

          let result: Response | undefined
          let error: unknown
          try {
            result = await runRetrySequence({
              attempt: async () => {
                const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
                calls++
                if (outcome.kind === 'error') {
                  throw new TypeError(outcome.message)
                }
                return new Response(null, { status: outcome.status })
              },
              retries,
              delay: 0,
              decide: shouldRetry,
              request,
              metadata: retryMetadata(retries, 0),
            })
          } catch (caught) {
            error = caught
          }

          expect(calls).toBeLessThanOrEqual(budget)

          const terminal = outcomes[Math.min(calls - 1, outcomes.length - 1)]
          if (terminal.kind === 'error') {
            expect(calls).toBe(budget)
            expect(error).toBeInstanceOf(TypeError)
            expect(result).toBeUndefined()
          } else {
            expect(error).toBeUndefined()
            expect(result?.status).toBe(terminal.status)
            if (isRetryable(terminal.status)) expect(calls).toBe(budget)
          }
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('does not start another attempt when aborted during backoff', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 6 }),
        async (abortAt, retries) => {
          vi.useFakeTimers()

          const controller = new AbortController()
          const onAbort = vi.fn()
          let calls = 0
          const client = createClient({
            retries,
            retryDelay: abortAt + 1,
            hooks: { onAbort },
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          const resultPromise = client('https://example.com/retry-abort', {
            signal: controller.signal,
          })
          const assertion =
            expect(resultPromise).rejects.toBeInstanceOf(AbortError)
          setTimeout(() => controller.abort(), abortAt)
          await vi.runAllTimersAsync()
          await assertion

          expect(calls).toBe(1)
          expect(onAbort).toHaveBeenCalledOnce()
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('times out once during backoff without starting another attempt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 6 }),
        async (timeout, retries) => {
          const onTimeout = vi.fn()
          const onComplete = vi.fn()
          let calls = 0
          const client = createClient({
            timeout,
            retries,
            retryDelay: timeout + 10,
            hooks: { onTimeout, onComplete },
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          await expect(
            client('https://example.com/retry-timeout')
          ).rejects.toBeInstanceOf(TimeoutError)

          expect(calls).toBe(1)
          expect(onTimeout).toHaveBeenCalledOnce()
          expect(onComplete).toHaveBeenCalledOnce()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('converts generated Retry-After seconds into milliseconds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 86_400 }), (seconds) => {
        const response = new Response(null, {
          status: 429,
          headers: { 'Retry-After': String(seconds) },
        })
        const ctx = {
          attempt: 1,
          request: new Request('https://example.com/retry-after'),
          response,
        }
        const delay =
          typeof defaultDelay === 'function' ? defaultDelay(ctx) : defaultDelay

        expect(delay).toBe(seconds * 1_000)
      }),
      { numRuns: 1_000 }
    )
  })
  it('reports one outcome per attempt and records the attempt a run ends on', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(retryOutcomeArbitrary, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 6 }),
        async (outcomes, retries) => {
          let calls = 0
          const offered: { error?: unknown; response?: Response }[] = []
          const metadata = retryMetadata(retries, 0)

          let result: Response | undefined
          try {
            result = await runRetrySequence({
              attempt: async () => {
                const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
                calls++
                if (outcome.kind === 'error') {
                  throw new TypeError(outcome.message)
                }
                return new Response(null, { status: outcome.status })
              },
              retries,
              delay: 0,
              decide: (ctx) => {
                offered.push({ error: ctx.error, response: ctx.response })
                return shouldRetry(ctx)
              },
              request: new Request('https://example.com/retry-report'),
              metadata,
            })
          } catch {
            // A run that ends in a failure is an outcome here, not the subject.
          }

          // A decision is asked about one attempt, and an attempt either fails or
          // produces a response - never both, and never one an earlier attempt
          // left behind.
          for (const ctx of offered) {
            expect(ctx.error === undefined).toBe(ctx.response !== undefined)
          }

          // The attempt the run ends on is the attempt the metadata describes.
          expect(metadata.attempt).toBe(calls)
          expect(metadata.lastResponse).toBe(result)
          if (result === undefined) {
            expect(metadata.lastError).toBeInstanceOf(TypeError)
          }

          // The attempt that uses up the budget is never offered for a retry, so
          // no answer about it is left in the metadata.
          if (calls === retries + 1) {
            expect(metadata.shouldRetryResult).toBeUndefined()
          }
        }
      ),
      { numRuns: 500 }
    )
  })
})
