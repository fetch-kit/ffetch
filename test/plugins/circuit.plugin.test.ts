import { describe, it, expect, vi } from 'vitest'

import { createClient } from '../../src/client.js'
import {
  AbortError,
  BulkheadFullError,
  CircuitOpenError,
  HttpError,
  NetworkError,
  TimeoutError,
} from '../../src/error.js'
import { bulkheadPlugin } from '../../src/plugins/bulkhead.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'

describe('circuit plugin parity', () => {
  it('opens after threshold failures and blocks while open', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 2, reset: 1000 })],
    })

    const r1 = await client('https://example.com/circuit-1')
    await expect(client('https://example.com/circuit-2')).rejects.toThrow(
      CircuitOpenError
    )

    expect(r1.status).toBe(500)
    expect(client.circuitOpen).toBe(true)

    await expect(client('https://example.com/circuit-3')).rejects.toThrow(
      CircuitOpenError
    )
  })

  it('resets after timeout and closes on a successful probe', async () => {
    let failMode = true
    global.fetch = vi.fn().mockImplementation(async () => {
      if (failMode) {
        return new Response('fail', { status: 500 })
      }
      return new Response('ok', { status: 200 })
    })

    const onCircuitOpen = vi.fn()
    const onCircuitClose = vi.fn()

    const client = createClient({
      retries: 0,
      plugins: [
        circuitPlugin({
          threshold: 1,
          reset: 50,
          onCircuitOpen,
          onCircuitClose,
        }),
      ],
    })

    await expect(client('https://example.com/open')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
    expect(onCircuitOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: expect.objectContaining({ type: 'threshold-reached' }),
      })
    )

    await expect(client('https://example.com/blocked')).rejects.toThrow(
      CircuitOpenError
    )
    expect(onCircuitOpen).toHaveBeenCalledTimes(2)
    expect(onCircuitOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: { type: 'already-open' },
      })
    )

    await new Promise((resolve) => setTimeout(resolve, 70))

    failMode = false
    const recovered = await client('https://example.com/recover')

    expect(recovered.status).toBe(200)
    expect(client.circuitOpen).toBe(false)
    expect(onCircuitClose).toHaveBeenCalledTimes(1)
    expect(onCircuitClose).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        response: expect.any(Response),
      })
    )
  })

  it('treats HTTP 429 as a circuit failure signal', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 200 })],
    })

    await expect(client('https://example.com/rate-limit')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)

    await expect(client('https://example.com/rate-limit-2')).rejects.toThrow(
      CircuitOpenError
    )
  })

  it('resets failure counter after success before reaching threshold', async () => {
    const statuses = [500, 200, 500, 200]
    global.fetch = vi.fn().mockImplementation(async () => {
      const status = statuses.shift() ?? 200
      return new Response(String(status), { status })
    })

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 2, reset: 500 })],
    })

    await client('https://example.com/mix-1')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-2')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-3')
    expect(client.circuitOpen).toBe(false)

    await client('https://example.com/mix-4')
    expect(client.circuitOpen).toBe(false)
  })

  it('counts network errors (thrown) toward threshold, not just bad responses', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network fail'))

    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 3, reset: 500 })],
    })

    // First two throw the underlying error — circuit not open yet
    await expect(client('https://example.com/net-1')).rejects.toThrow(
      'network fail'
    )
    expect(client.circuitOpen).toBe(false)

    await expect(client('https://example.com/net-2')).rejects.toThrow(
      'network fail'
    )
    expect(client.circuitOpen).toBe(false)

    // Third failure reaches threshold — circuit opens, error is rewritten to CircuitOpenError
    await expect(client('https://example.com/net-3')).rejects.toThrow(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)
  })

  it('fires onCircuitOpen and onCircuitClose when failure is a network error', async () => {
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) throw new Error('fail')
      return new Response('ok')
    })

    const onCircuitOpen = vi.fn()
    const onCircuitClose = vi.fn()

    const client = createClient({
      retries: 0,
      plugins: [
        circuitPlugin({
          threshold: 2,
          reset: 50,
          onCircuitOpen,
          onCircuitClose,
        }),
      ],
    })

    await expect(client('https://example.com/hooks-net-1')).rejects.toThrow(
      'fail'
    )
    await expect(client('https://example.com/hooks-net-2')).rejects.toThrow(
      CircuitOpenError
    )
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
    expect(onCircuitOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        reason: expect.objectContaining({
          type: 'threshold-reached',
          error: expect.any(Error),
        }),
      })
    )
    expect(client.circuitOpen).toBe(true)

    await new Promise((r) => setTimeout(r, 70))

    const recovered = await client('https://example.com/hooks-net-recover')
    expect(recovered.status).toBe(200)
    expect(onCircuitClose).toHaveBeenCalledTimes(1)
    expect(onCircuitClose).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        response: expect.any(Response),
      })
    )
    expect(client.circuitOpen).toBe(false)
  })
})

describe('circuit plugin failure classification', () => {
  it.each([429, 500, 502, 503])(
    'counts a %i surfaced by throwOnHttpError as a dependency failure',
    async (status) => {
      const onCircuitOpen = vi.fn()
      const client = createClient({
        retries: 0,
        throwOnHttpError: true,
        plugins: [circuitPlugin({ threshold: 2, reset: 1_000, onCircuitOpen })],
        fetchHandler: async () => new Response(null, { status }),
      })

      await expect(
        client('https://example.com/http-failure-1')
      ).rejects.toBeInstanceOf(HttpError)
      expect(client.circuitOpen).toBe(false)

      await expect(
        client('https://example.com/http-failure-2')
      ).rejects.toBeInstanceOf(CircuitOpenError)
      expect(client.circuitOpen).toBe(true)
      expect(onCircuitOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({
            type: 'threshold-reached',
            error: expect.any(HttpError),
          }),
        })
      )
    }
  )

  it('does not count a 4xx that throwOnHttpError turns into an HttpError', async () => {
    const onCircuitOpen = vi.fn()
    const client = createClient({
      retries: 0,
      throwOnHttpError: true,
      plugins: [circuitPlugin({ threshold: 2, reset: 1_000, onCircuitOpen })],
      fetchHandler: async () => new Response('not found', { status: 404 }),
    })

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        client(`https://example.com/http-4xx-${attempt}`)
      ).rejects.toThrow('HTTP error: 404')
      expect(client.circuitOpen).toBe(false)
    }

    expect(onCircuitOpen).not.toHaveBeenCalled()
  })

  it('resets the failure count on a 4xx surfaced as an HttpError', async () => {
    const statuses = [503, 404, 503, 404]
    let calls = 0
    const client = createClient({
      retries: 0,
      throwOnHttpError: true,
      plugins: [circuitPlugin({ threshold: 2, reset: 1_000 })],
      fetchHandler: async () =>
        new Response(null, { status: statuses[calls++] }),
    })

    for (let attempt = 0; attempt < statuses.length; attempt++) {
      await expect(
        client(`https://example.com/http-reset-${attempt}`)
      ).rejects.toBeInstanceOf(HttpError)
      expect(client.circuitOpen).toBe(false)
    }

    expect(calls).toBe(statuses.length)
  })

  it('does not count a bulkhead rejection as a dependency failure', async () => {
    let releaseHeld!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const fetchHandler = vi.fn(async (input: RequestInfo | URL) => {
      if (new URL((input as Request).url).pathname === '/bulkhead-held') {
        await held
      }
      return new Response('ok', { status: 200 })
    })
    const client = createClient({
      retries: 0,
      fetchHandler,
      plugins: [
        bulkheadPlugin({ maxConcurrent: 1, maxQueue: 0 }),
        circuitPlugin({ threshold: 1, reset: 1_000 }),
      ],
    })

    const active = client('https://example.com/bulkhead-held')
    await vi.waitFor(() => expect(client.activeCount).toBe(1))

    await expect(
      client('https://example.com/bulkhead-full')
    ).rejects.toBeInstanceOf(BulkheadFullError)
    expect(client.circuitOpen).toBe(false)

    releaseHeld()
    await active

    // The circuit never opened, so a request that fits is still dispatched.
    await expect(
      client('https://example.com/bulkhead-after')
    ).resolves.toMatchObject({ status: 200 })
    expect(client.circuitOpen).toBe(false)
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })

  it('does not count a user abort as a dependency failure', async () => {
    const controller = new AbortController()
    const fetchHandler = vi.fn(async (input: RequestInfo | URL) => {
      if (new URL((input as Request).url).pathname === '/aborted') {
        // The caller aborts while the attempt is in flight, so the attempt
        // fails with the caller's own reason.
        controller.abort(new Error('cancelled by the caller'))
        throw controller.signal.reason
      }
      return new Response('ok', { status: 200 })
    })
    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 1_000 })],
      fetchHandler,
    })

    await expect(
      client('https://example.com/aborted', { signal: controller.signal })
    ).rejects.toBeInstanceOf(AbortError)
    expect(client.circuitOpen).toBe(false)

    await expect(
      client('https://example.com/after-abort')
    ).resolves.toMatchObject({ status: 200 })
    expect(client.circuitOpen).toBe(false)
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })

  it('does not count an error thrown by a hook as a dependency failure', async () => {
    let calls = 0
    const fetchHandler = vi.fn(async () => new Response('ok', { status: 200 }))
    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 1_000 })],
      hooks: {
        transformResponse: (res) => {
          if (++calls === 1) throw new Error('transform failed')
          return res
        },
      },
      fetchHandler,
    })

    await expect(client('https://example.com/hook-error')).rejects.toThrow(
      'transform failed'
    )
    expect(client.circuitOpen).toBe(false)

    await expect(
      client('https://example.com/after-hook-error')
    ).resolves.toMatchObject({ status: 200 })
    expect(client.circuitOpen).toBe(false)
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })

  it('does not count a hook that throws a dependency error type', async () => {
    // The error type says what the hook decided to report, not what the
    // dependency did. The core marks the error as raised outside the attempt, so
    // it is not evidence about the dependency even when it is typed as one.
    let calls = 0
    const fetchHandler = vi.fn(async () => new Response('ok', { status: 200 }))
    const client = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 1_000 })],
      hooks: {
        transformResponse: (res) => {
          if (++calls === 1) {
            throw new HttpError(
              'upstream looks down',
              new Response(null, { status: 503 })
            )
          }
          return res
        },
      },
      fetchHandler,
    })

    await expect(
      client('https://example.com/typed-hook-error')
    ).rejects.toBeInstanceOf(HttpError)
    expect(client.circuitOpen).toBe(false)

    await expect(
      client('https://example.com/after-typed-hook-error')
    ).resolves.toMatchObject({ status: 200 })
    expect(client.circuitOpen).toBe(false)
    expect(calls).toBe(2)
  })

  it('does not count a refusal that uses a dependency error type', async () => {
    // Refusing an attempt is local code, and a plugin is free to use one of the
    // core error types to do it. That is not the attempt timing out.
    const fetchHandler = vi.fn(async () => new Response('ok', { status: 200 }))
    const client = createClient({
      retries: 0,
      plugins: [
        {
          name: 'refuser',
          beforeAttempt: () => {
            throw new TimeoutError('refused locally')
          },
        },
        circuitPlugin({ threshold: 1, reset: 1_000 }),
      ],
      fetchHandler,
    })

    await expect(
      client('https://example.com/typed-refusal')
    ).rejects.toBeInstanceOf(TimeoutError)
    expect(client.circuitOpen).toBe(false)
    expect(fetchHandler).not.toHaveBeenCalled()
  })

  it('does not count a dependency error type raised by a retry policy', async () => {
    // The policy runs between attempts, so an error it raises is its own - not
    // the attempt reporting a network failure.
    const fetchHandler = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = createClient({
      retries: 1,
      retryDelay: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 1_000 })],
      shouldRetry: () => {
        throw new NetworkError('the policy gave up')
      },
      fetchHandler,
    })

    await expect(
      client('https://example.com/typed-policy-error')
    ).rejects.toBeInstanceOf(NetworkError)
    expect(client.circuitOpen).toBe(false)
    expect(fetchHandler).toHaveBeenCalledTimes(1)
  })

  it('counts a timeout as a dependency failure', async () => {
    const onCircuitOpen = vi.fn()
    const client = createClient({
      retries: 0,
      timeout: 10,
      plugins: [circuitPlugin({ threshold: 1, reset: 1_000, onCircuitOpen })],
      fetchHandler: async (input: RequestInfo | URL) => {
        const request = input as Request
        await new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true }
          )
        })
        return new Response('unreachable')
      },
    })

    await expect(client('https://example.com/timeout')).rejects.toBeInstanceOf(
      CircuitOpenError
    )
    expect(client.circuitOpen).toBe(true)
    expect(onCircuitOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: 'threshold-reached',
          error: expect.any(TimeoutError),
        }),
      })
    )
  })
})

describe('circuit plugin admission at dispatch', () => {
  it('refuses a retry that was admitted before the circuit opened while it waited', async () => {
    const calls: string[] = []
    let firstAttempt!: () => void
    const attempted = new Promise<void>((resolve) => {
      firstAttempt = resolve
    })
    const onCircuitOpen = vi.fn()

    const client = createClient({
      plugins: [circuitPlugin({ threshold: 1, reset: 60_000, onCircuitOpen })],
      fetchHandler: async (input: RequestInfo | URL) => {
        const path = new URL((input as Request).url).pathname
        calls.push(path)
        if (path === '/primary') {
          firstAttempt()
        }
        throw new TypeError('offline')
      },
    })

    // The first attempt fails and the request waits for its retry delay, with
    // its next attempt already admitted by `preRequest`.
    const primary = client('https://example.com/primary', {
      retries: 1,
      retryDelay: 150,
    })
    primary.catch(() => {})
    await attempted

    // Another request trips the breaker while the retry is still waiting.
    await expect(
      client('https://example.com/tripper', { retries: 0 })
    ).rejects.toBeInstanceOf(CircuitOpenError)
    expect(client.circuitOpen).toBe(true)

    // The waiting retry is refused at dispatch instead of being sent into the
    // open circuit, and the refusal keeps its identity rather than being
    // reported as a retry limit that was reached because of the dependency.
    await expect(primary).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls.filter((path) => path === '/primary')).toHaveLength(1)
    expect(onCircuitOpen).toHaveBeenCalledTimes(2)
    expect(onCircuitOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: { type: 'already-open' } })
    )
  })
})
