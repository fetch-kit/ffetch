import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import {
  AbortError,
  HttpError,
  NetworkError,
  RetryLimitError,
  TimeoutError,
} from '../../src/error.js'
import type { Hooks } from '../../src/hooks.js'

const httpStatusArbitrary = fc.constantFrom(200, 204, 400, 404, 429, 500, 503)

afterEach(() => {
  vi.useRealTimers()
})

describe('core client fuzzing', () => {
  it('abortAll aborts every tracked physical request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (requestCount) => {
        const signals: AbortSignal[] = []
        const resolvers: Array<(response: Response) => void> = []
        const client = createClient({
          timeout: 0,
          fetchHandler: async (input) => {
            signals.push((input as Request).signal)
            return new Promise<Response>((resolve) => {
              resolvers.push(resolve)
            })
          },
        })

        const requests = Array.from({ length: requestCount }, (_, index) =>
          client(`https://example.com/pending/${index}`)
        )
        for (
          let turn = 0;
          turn < 10 && client.pendingRequests.length < requestCount;
          turn++
        ) {
          await Promise.resolve()
        }
        expect(client.pendingRequests).toHaveLength(requestCount)

        client.abortAll()
        const allSignalsAborted = signals.every((signal) => signal.aborted)

        // Always settle the synthetic transport so a failing property does
        // not leave promises pending while fast-check shrinks it.
        resolvers.forEach((resolve) => resolve(new Response(null)))
        await Promise.allSettled(requests)

        expect(allSignalsAborted).toBe(true)
        expect(client.pendingRequests).toHaveLength(0)
      }),
      { numRuns: 250 }
    )
  })

  it('clones request bodies intact across every retry attempt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        fc.constantFrom('POST', 'PUT', 'PATCH'),
        fc.integer({ min: 0, max: 5 }),
        async (body, method, retries) => {
          const observedBodies: string[] = []
          let calls = 0
          const client = createClient({
            retries,
            retryDelay: 0,
            fetchHandler: async (input) => {
              calls++
              observedBodies.push(await (input as Request).text())
              return new Response(null, {
                status: calls <= retries ? 503 : 200,
              })
            },
          })

          const response = await client('https://example.com/body', {
            method,
            body,
          })

          expect(response.status).toBe(200)
          expect(calls).toBe(retries + 1)
          expect(observedBodies).toEqual(Array(retries + 1).fill(body))
        }
      ),
      { numRuns: 500 }
    )
  })

  it('obeys generated custom retry policies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(httpStatusArbitrary, { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(httpStatusArbitrary, { maxLength: 7 }),
        fc.integer({ min: 0, max: 6 }),
        async (statuses, retryStatuses, retries) => {
          const retrySet = new Set(retryStatuses)
          let calls = 0
          const client = createClient({
            retries,
            retryDelay: 0,
            shouldRetry: ({ response }) =>
              response !== undefined && retrySet.has(response.status),
            fetchHandler: async () => {
              const status = statuses[Math.min(calls, statuses.length - 1)]
              calls++
              return new Response(null, { status })
            },
          })

          const response = await client('https://example.com/custom-policy')

          let expectedCalls = 0
          let expectedStatus = statuses[0]
          while (expectedCalls < retries + 1) {
            expectedStatus =
              statuses[Math.min(expectedCalls, statuses.length - 1)]
            expectedCalls++
            if (!retrySet.has(expectedStatus)) break
          }

          expect(response.status).toBe(expectedStatus)
          expect(calls).toBe(expectedCalls)
        }
      ),
      { numRuns: 1_000 }
    )
  })

  it('maps generated HTTP statuses according to throwOnHttpError', async () => {
    await fc.assert(
      fc.asyncProperty(
        httpStatusArbitrary,
        fc.boolean(),
        async (status, throwOnHttpError) => {
          const client = createClient({
            retries: 0,
            throwOnHttpError,
            fetchHandler: async () => new Response(null, { status }),
          })

          let response: Response | undefined
          let error: unknown
          try {
            response = await client('https://example.com/http-errors')
          } catch (caught) {
            error = caught
          }

          if (throwOnHttpError && status >= 400) {
            expect(error).toBeInstanceOf(HttpError)
            expect(response).toBeUndefined()
          } else {
            expect(error).toBeUndefined()
            expect(response?.status).toBe(status)
          }
        }
      ),
      { numRuns: 500 }
    )
  })

  it('removes every request from pendingRequests after mixed outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (succeeds) => {
          let calls = 0
          const client = createClient({
            retries: 0,
            fetchHandler: async () => {
              const success = succeeds[calls++]
              if (!success) throw new Error('generated failure')
              return new Response(null)
            },
          })

          const requests = succeeds.map((_, index) =>
            client(`https://example.com/lifecycle/${index}`)
          )
          await Promise.allSettled(requests)

          expect(calls).toBe(succeeds.length)
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('honors per-request retry and HTTP-error overrides', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        fc.boolean(),
        async (defaultRetries, requestRetries, defaultThrow, requestThrow) => {
          let calls = 0
          const client = createClient({
            retries: defaultRetries,
            retryDelay: 0,
            throwOnHttpError: defaultThrow,
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          let response: Response | undefined
          let error: unknown
          try {
            response = await client('https://example.com/overrides', {
              retries: requestRetries,
              throwOnHttpError: requestThrow,
            })
          } catch (caught) {
            error = caught
          }

          expect(calls).toBe(requestRetries + 1)
          if (requestThrow) {
            expect(error).toBeInstanceOf(HttpError)
            expect(response).toBeUndefined()
          } else {
            expect(error).toBeUndefined()
            expect(response?.status).toBe(503)
          }
        }
      ),
      { numRuns: 500 }
    )
  })

  it('passes accurate contexts to generated retry-delay functions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 20 }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (delays) => {
          vi.useFakeTimers()

          const attempts: number[] = []
          let calls = 0
          const client = createClient({
            timeout: 0,
            retries: delays.length,
            retryDelay: (context) => {
              attempts.push(context.attempt)
              expect(context.response?.status).toBe(503)
              expect(context.error).toBeUndefined()
              return delays[context.attempt - 1]
            },
            fetchHandler: async () => {
              calls++
              return new Response(null, { status: 503 })
            },
          })

          const resultPromise = client('https://example.com/custom-delay')
          await vi.runAllTimersAsync()
          const response = await resultPromise

          expect(response.status).toBe(503)
          expect(calls).toBe(delays.length + 1)
          expect(attempts).toEqual(
            Array.from({ length: delays.length }, (_, index) => index + 1)
          )
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('classifies generated terminal transport failures', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('failed to fetch', 'connection-reset'),
        fc.integer({ min: 0, max: 5 }),
        async (message, retries) => {
          let calls = 0
          const client = createClient({
            retries,
            retryDelay: 0,
            fetchHandler: async () => {
              calls++
              if (message === 'failed to fetch') throw new TypeError(message)
              throw new Error(message)
            },
          })

          let error: unknown
          try {
            await client('https://example.com/error-mapping')
          } catch (caught) {
            error = caught
          }

          expect(calls).toBe(retries + 1)
          if (message === 'failed to fetch') {
            expect(error).toBeInstanceOf(NetworkError)
          } else {
            expect(error).toBeInstanceOf(RetryLimitError)
          }
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('propagates transformed-request cancellation exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (abortAt) => {
        vi.useFakeTimers()

        const transformed = new AbortController()
        const onAbort = vi.fn()
        let calls = 0
        const client = createClient({
          timeout: 0,
          hooks: {
            transformRequest: (request) =>
              new Request(request, { signal: transformed.signal }),
            onAbort,
          },
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
        })

        const resultPromise = client('https://example.com/transformed-abort')
        const assertion =
          expect(resultPromise).rejects.toBeInstanceOf(AbortError)
        setTimeout(() => transformed.abort(), abortAt)
        await vi.runAllTimersAsync()
        await assertion

        expect(calls).toBe(1)
        expect(onAbort).toHaveBeenCalledOnce()
        expect(client.pendingRequests).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)

        vi.useRealTimers()
      }),
      { numRuns: 250 }
    )
  })

  it('settles once when generated cancellation sources race', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .record({
            user: fc.boolean(),
            transformed: fc.boolean(),
            abortAll: fc.boolean(),
          })
          .filter(({ user, transformed, abortAll }) =>
            Boolean(user || transformed || abortAll)
          ),
        async (sources) => {
          vi.useFakeTimers()

          const user = new AbortController()
          const transformed = new AbortController()
          const onAbort = vi.fn()
          const onError = vi.fn()
          const onComplete = vi.fn()
          let physicalSettlements = 0
          const client = createClient({
            timeout: 0,
            hooks: {
              transformRequest: sources.transformed
                ? (request) =>
                    new Request(request, { signal: transformed.signal })
                : undefined,
              onAbort,
              onError,
              onComplete,
            },
            fetchHandler: async (input) => {
              const signal = (input as Request).signal
              return new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                  physicalSettlements++
                  reject(new DOMException('Aborted', 'AbortError'))
                }
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            },
          })

          const resultPromise = client('https://example.com/signal-race', {
            signal: sources.user ? user.signal : undefined,
          })
          let error: unknown
          resultPromise.catch((caught) => {
            error = caught
          })

          for (
            let turn = 0;
            turn < 10 && client.pendingRequests.length === 0;
            turn++
          ) {
            await Promise.resolve()
          }

          setTimeout(() => {
            if (sources.transformed) transformed.abort()
            if (sources.abortAll) client.abortAll()
            if (sources.user) user.abort()
          }, 0)
          await vi.runAllTimersAsync()
          await Promise.allSettled([resultPromise])

          expect(error).toBeInstanceOf(AbortError)
          if (sources.user) {
            expect((error as Error).message).toBe('Request was aborted by user')
          }
          expect(physicalSettlements).toBe(1)
          expect(onAbort).toHaveBeenCalledOnce()
          expect(onError).toHaveBeenCalledOnce()
          expect(onComplete).toHaveBeenCalledOnce()
          expect(client.pendingRequests).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(0)

          vi.useRealTimers()
        }
      ),
      { numRuns: 500 }
    )
  })

  it('gives user abort precedence when it races the overall timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .record({ user: fc.boolean(), timeout: fc.boolean() })
          .filter(({ user, timeout }) => user || timeout),
        async (sources) => {
          vi.useFakeTimers()

          const originalTimeout = AbortSignal.timeout
          const timeout = new AbortController()
          const user = new AbortController()
          AbortSignal.timeout = (() =>
            timeout.signal) as typeof AbortSignal.timeout

          try {
            const client = createClient({
              timeout: 1,
              fetchHandler: async (input) => {
                const signal = (input as Request).signal
                return new Promise<Response>((_resolve, reject) => {
                  const abort = () =>
                    reject(new DOMException('Aborted', 'AbortError'))
                  if (signal.aborted) abort()
                  else signal.addEventListener('abort', abort, { once: true })
                })
              },
            })

            const resultPromise = client('https://example.com/timeout-race', {
              signal: user.signal,
            })
            let error: unknown
            const observedResult = resultPromise.catch((caught) => {
              error = caught
            })
            setTimeout(() => {
              if (sources.timeout) timeout.abort()
              if (sources.user) user.abort()
            }, 0)
            await vi.runAllTimersAsync()
            await observedResult

            if (sources.user) {
              expect(error).toBeInstanceOf(AbortError)
            } else {
              expect(error).toBeInstanceOf(TimeoutError)
            }
            expect(client.pendingRequests).toHaveLength(0)
            expect(vi.getTimerCount()).toBe(0)
          } finally {
            AbortSignal.timeout = originalTimeout
            vi.useRealTimers()
          }
        }
      ),
      { numRuns: 250 }
    )
  })

  it('cleans up requests when generated lifecycle hooks fail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'before',
          'after',
          'onComplete',
          'transformRequest',
          'transformResponse',
          'onError',
          'onRetry'
        ),
        fc.boolean(),
        async (hookName, asynchronous) => {
          const hookError = new Error(`generated ${hookName} failure`)
          const calls = vi.fn()
          const fail = asynchronous
            ? async () => {
                calls()
                throw hookError
              }
            : () => {
                calls()
                throw hookError
              }

          const hooks: Hooks = {}
          Object.assign(hooks, { [hookName]: fail })

          let fetchCalls = 0
          const client = createClient({
            retries: hookName === 'onRetry' ? 1 : 0,
            retryDelay: 0,
            hooks,
            fetchHandler: async () => {
              fetchCalls++
              if (hookName === 'onError') throw new Error('transport failure')
              if (hookName === 'onRetry' && fetchCalls === 1) {
                return new Response(null, { status: 503 })
              }
              return new Response(null)
            },
          })

          const result = await Promise.allSettled([
            client(`https://example.com/hook-failure/${hookName}`),
          ])
          await Promise.resolve()

          expect(result).toHaveLength(1)
          expect(calls).toHaveBeenCalled()
          expect(client.pendingRequests).toHaveLength(0)
        }
      ),
      { numRuns: 500 }
    )
  })
})
