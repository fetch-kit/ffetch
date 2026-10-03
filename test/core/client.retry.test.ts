import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../../src/client.js'
import { AbortError, RetryLimitError } from '../../src/error.js'

/**
 * The retry sequence the pipeline runs: which attempt is re-sent, in which
 * order the policy, the `onRetry` hook and the delay see it, and what the
 * attempt numbers and the retry metadata say while it runs.
 */
describe('Retry sequence', () => {
  it('numbers attempts from one and stops at the attempt that succeeds', async () => {
    const numbers: number[] = []
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw new Error(`fail ${calls}`)
      return new Response('ok')
    })
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      plugins: [
        {
          name: 'attempt-numbers',
          beforeAttempt: (_ctx, attempt) => {
            numbers.push(attempt)
          },
        },
      ],
    })

    const response = await f('https://example.com/attempt-numbers')

    expect(response.status).toBe(200)
    expect(calls).toBe(3)
    expect(numbers).toEqual([1, 2, 3])
  })

  // `attempt` is zero-based in `onRetry` (0 = the first retry), which is the
  // documented contract in docs/hooks.md.
  it('tells onRetry which retry it is, and which attempt failed, before it runs', async () => {
    const failures = [new Error('fail 1'), new Error('fail 2')]
    const retries: unknown[] = []
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      const failure = failures[calls]
      calls++
      if (failure) throw failure
      return new Response('ok')
    })
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      hooks: {
        onRetry: (request, attempt, error, response) => {
          retries.push({ attempt, error, response, url: request.url })
        },
      },
    })

    await f('https://example.com/on-retry')

    expect(calls).toBe(3)
    expect(retries).toEqual([
      {
        attempt: 0,
        error: failures[0],
        response: undefined,
        url: 'https://example.com/on-retry',
      },
      {
        attempt: 1,
        error: failures[1],
        response: undefined,
        url: 'https://example.com/on-retry',
      },
    ])
  })

  it('tells onRetry about the response that is re-sent instead of an error', async () => {
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      return new Response(calls === 1 ? 'busy' : 'ok', {
        status: calls === 1 ? 503 : 200,
      })
    })
    const onRetry = vi.fn()
    const f = createClient({
      retries: 1,
      retryDelay: 0,
      shouldRetry: (ctx) => ctx.response?.status === 503,
      hooks: { onRetry },
    })

    const response = await f('https://example.com/re-send')

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    const [, attempt, error, reSent] = onRetry.mock.calls[0]
    expect(attempt).toBe(0)
    expect(error).toBeUndefined()
    expect(reSent).toBeInstanceOf(Response)
    expect((reSent as Response).status).toBe(503)
  })

  it('consults the retry policy only for the attempts that can be re-sent', async () => {
    const failed = [
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
    ]
    const decisions: unknown[] = []
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      throw failed[calls++]
    })
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      shouldRetry: (ctx) => {
        decisions.push({
          attempt: ctx.attempt,
          error: ctx.error,
          status: ctx.response?.status,
        })
        return true
      },
    })

    await expect(f('https://example.com/policy')).rejects.toBeInstanceOf(
      RetryLimitError
    )

    expect(calls).toBe(3)
    expect(decisions).toEqual([
      { attempt: 1, error: failed[0], status: undefined },
      { attempt: 2, error: failed[1], status: undefined },
    ])
  })

  it('does not consult the retry policy when the attempt cannot be re-sent', async () => {
    const policy = vi.fn(() => true)
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({ retries: 0, shouldRetry: policy })

    await expect(f('https://example.com/no-budget')).rejects.toBeInstanceOf(
      RetryLimitError
    )

    expect(policy).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns the attempt the policy refuses to re-send', async () => {
    const policy = vi.fn(() => false)
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }))
    const f = createClient({ retries: 3, retryDelay: 0, shouldRetry: policy })

    const response = await f('https://example.com/refused')

    expect(response.status).toBe(503)
    expect(policy).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('records the attempt that finished in the retry metadata', async () => {
    const failures = [new Error('fail 1'), new Error('fail 2')]
    const seen: unknown[] = []
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      const failure = failures[calls]
      calls++
      if (failure) throw failure
      return new Response('ok')
    })
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      plugins: [
        {
          name: 'retry-metadata',
          beforeAttempt: (ctx, attempt) => {
            seen.push({ attempt, retry: { ...ctx.metadata.retry } })
          },
        },
      ],
    })

    await f('https://example.com/retry-metadata')

    expect(seen).toEqual([
      {
        attempt: 1,
        retry: { configuredRetries: 2, configuredDelay: 0, attempt: 0 },
      },
      {
        attempt: 2,
        retry: {
          configuredRetries: 2,
          configuredDelay: 0,
          attempt: 1,
          lastError: failures[0],
          lastResponse: undefined,
          shouldRetryResult: true,
        },
      },
      {
        attempt: 3,
        retry: {
          configuredRetries: 2,
          configuredDelay: 0,
          attempt: 2,
          lastError: failures[1],
          lastResponse: undefined,
          shouldRetryResult: true,
        },
      },
    ])
  })

  it('cancels the response it discards, after onRetry and before the delay', async () => {
    const events: string[] = []
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls > 1) return new Response('ok')
      return new Response(
        new ReadableStream({
          cancel: () => {
            events.push('cancel')
          },
        }),
        { status: 503 }
      )
    })
    const f = createClient({
      retries: 1,
      shouldRetry: (ctx) => {
        events.push('decide')
        return ctx.response?.status === 503
      },
      retryDelay: () => {
        events.push('delay')
        return 0
      },
      hooks: {
        onRetry: () => {
          events.push('onRetry')
        },
      },
    })

    const response = await f('https://example.com/discarded-body')

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(events).toEqual(['decide', 'onRetry', 'cancel', 'delay'])
  })

  it('keeps the request alive when the discarded body cannot be released', async () => {
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls > 1) return new Response('ok')
      return new Response(
        new ReadableStream({
          cancel: () => Promise.reject(new Error('cancel failed')),
        }),
        { status: 503 }
      )
    })
    const f = createClient({
      retries: 1,
      shouldRetry: (ctx) => ctx.response?.status === 503,
    })

    const response = await f('https://example.com/unreleasable-body')

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('fails the retry when the request is aborted during the wait', async () => {
    const controller = new AbortController()
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      return new Response(null, { status: 503 })
    })
    const f = createClient({
      retries: 1,
      retryDelay: 60_000,
      hooks: {
        onRetry: () => controller.abort(),
      },
    })

    const started = Date.now()
    const aborted = f('https://example.com/abort-during-wait', {
      signal: controller.signal,
    })

    await expect(aborted).rejects.toBeInstanceOf(AbortError)
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
