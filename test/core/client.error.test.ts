// Edge case: throwOnHttpError true, retries > 0, first error, later success
it('does not throw if a retry succeeds when throwOnHttpError is true', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) return new Response('fail', { status: 500 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({ throwOnHttpError: true, retries: 1 })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: custom shouldRetry retries on 400
it('retries on 400 if shouldRetry returns true', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) return new Response('fail', { status: 400 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({
    retries: 1,
    shouldRetry: (ctx: RetryContext) => ctx.response?.status === 400,
  })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: 429 with Retry-After, throwOnHttpError true, all attempts 429
it('retries on 429 with Retry-After and throws HttpError if all attempts are 429', async () => {
  global.fetch = vi.fn().mockImplementation(async () => {
    const r = new Response('fail', { status: 429 })
    Object.defineProperty(r, 'headers', {
      value: {
        get: (name: string) => (name === 'Retry-After' ? '0' : undefined),
      },
    })
    return r
  })
  const f = createClient({ throwOnHttpError: true, retries: 1 })
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

// Edge case: mixed error/success (network error, 5xx, 2xx)
it('returns 2xx if a retry eventually succeeds after network and 5xx errors', async () => {
  let calls = 0
  global.fetch = vi.fn().mockImplementation(async () => {
    calls++
    if (calls === 1) throw new TypeError('network error')
    if (calls === 2) return new Response('fail', { status: 500 })
    return new Response('ok', { status: 200 })
  })
  const f = createClient({ retries: 2 })
  const res = await f('https://test.com')
  expect(res.status).toBe(200)
  expect(global.fetch).toHaveBeenCalledTimes(3)
})

// Edge case: circuit breaker opens, throwOnHttpError true
it('throws CircuitOpenError if circuit opens due to repeated 5xx and throwOnHttpError is true', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f = createClient({
    throwOnHttpError: true,
    retries: 0,
    plugins: [circuitPlugin({ threshold: 2, reset: 100 })],
  })
  // First two requests fail, opening the circuit
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  await expect(f('https://test.com')).rejects.toThrow(CircuitOpenError)
})

// Edge case: per-request throwOnHttpError overrides client default
it('per-request throwOnHttpError overrides client default (both directions)', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f1 = createClient({ throwOnHttpError: false })
  await expect(
    f1('https://test.com', { throwOnHttpError: true })
  ).rejects.toThrow(HttpError)
  const f2 = createClient({ throwOnHttpError: true })
  const res = await f2('https://test.com', { throwOnHttpError: false })
  expect(res.status).toBe(500)
})

// Edge case: shouldRetry returns false for 5xx, throwOnHttpError true (should throw immediately, no retry)
it('throws immediately if shouldRetry returns false for 5xx and throwOnHttpError is true', async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response('fail', { status: 500 }))
  const f = createClient({
    throwOnHttpError: true,
    retries: 2,
    shouldRetry: () => false,
  })
  await expect(f('https://test.com')).rejects.toThrow(HttpError)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

// Edge case: abort/timeout with throwOnHttpError true (should throw AbortError/TimeoutError, not HttpError)
it('throws AbortError or TimeoutError, not HttpError, if aborted/timed out and throwOnHttpError is true', async () => {
  // Abort
  const controller = new AbortController()
  controller.abort()
  global.fetch = vi.fn().mockImplementation(async () => {
    throw new Error('fetch should not be called')
  })
  const f = createClient({ throwOnHttpError: true })
  await expect(
    f('https://test.com', { signal: controller.signal })
  ).rejects.toThrow(AbortError)

  // Timeout
  global.fetch = vi.fn().mockImplementation(async (input) => {
    const signal = input instanceof Request ? input.signal : undefined
    return await new Promise((_resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
    })
  })
  const f2 = createClient({ throwOnHttpError: true, timeout: 10 })
  await expect(f2('https://test.com')).rejects.toThrow(TimeoutError)
})
import { HttpError } from '../../src/error.js'
// Suppress unhandled promise rejections globally for this test file

import { describe, it, expect, vi } from 'vitest'
import {
  createClient,
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from '../../src/index.js'
import { circuitPlugin } from '../../src/plugins/circuit.js'
import type { RetryContext } from '../../src/types.js'

describe('Integration: Custom Errors', () => {
  it('throws HttpError on 4xx/5xx if throwOnHttpError is true (per-request)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 404 }))
    const f = createClient()
    await expect(
      f('https://test.com', { throwOnHttpError: true })
    ).rejects.toThrow(HttpError)
  })

  it('returns response on 4xx/5xx if throwOnHttpError is false (default)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 404 }))
    const f = createClient()
    const res = await f('https://test.com')
    expect(res.status).toBe(404)
  })

  it('throws HttpError on 4xx/5xx if throwOnHttpError is true (client default)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))
    const f = createClient({ throwOnHttpError: true })
    await expect(f('https://test.com')).rejects.toThrow(HttpError)
  })

  it('throws TimeoutError on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 20 })
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof TimeoutError && err.cause instanceof DOMException
    })
  }, 200)

  it('throws AbortError on user abort', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const controller = new AbortController()
    const f = createClient()
    setTimeout(() => controller.abort(), 20)
    await expect(
      f('https://example.com', { signal: controller.signal })
    ).rejects.toSatisfy((err) => {
      return (
        err instanceof AbortError &&
        err.message === 'Request was aborted by user' &&
        err.cause === undefined
      )
    })
  }, 200)

  it('throws CircuitOpenError when circuit is open', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 1, reset: 100 })],
    })
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
  })

  it('throws RetryLimitError when retry limit is reached', async () => {
    // The error message must match /retries? (exceeded|limit)/i for RetryLimitError
    global.fetch = vi.fn().mockRejectedValue(new Error('retry limit'))
    const f = createClient({ retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(RetryLimitError)
  })

  it('throws NetworkError on network error', async () => {
    const nativeErr = new TypeError(
      'NetworkError when attempting to fetch resource.'
    )
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient()
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof NetworkError && err.cause === nativeErr
    })
  })

  it('throws NetworkError on the message Safari uses for network errors', async () => {
    const nativeErr = new TypeError('Load failed')
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient()
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof NetworkError && err.cause === nativeErr
    })
  })
})

describe('Advanced/Edge Cases: Custom Errors', () => {
  it('TimeoutError: thrown after multiple retries', async () => {
    let attempts = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      attempts++
      // Simulate a timeout by rejecting with AbortError after a short delay
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new DOMException('aborted', 'AbortError')
    })
    const f = createClient({ timeout: 10, retries: 1 })
    // Accept either TimeoutError or AbortError due to timing differences in CI/Node environments
    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        (err instanceof TimeoutError && err.cause instanceof DOMException) ||
        (err instanceof AbortError && err.cause instanceof DOMException)
    )
    // If the timeout is too short, only 1 attempt may be made
    expect(attempts).toBeGreaterThanOrEqual(1)
  }, 2000)

  it('AbortError: thrown on user abort during retry', async () => {
    let abortFired = false
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      if (signal?.aborted) {
        abortFired = true
        throw new DOMException('aborted', 'AbortError')
      }
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            abortFired = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
        // Always reject to trigger retry
        setTimeout(() => reject(new Error('fail')), 5)
      })
    })
    const controller = new AbortController()
    const f = createClient({ retries: 1, timeout: 10 })
    setTimeout(() => controller.abort(), 15)
    await expect(
      f('https://example.com', { signal: controller.signal })
    ).rejects.toSatisfy(
      (err) =>
        (err instanceof AbortError &&
          err.message === 'Request was aborted by user' &&
          err.cause === undefined) ||
        err instanceof TimeoutError
    )
    expect(abortFired).toBe(true)
  }, 1000)

  it('AbortError: thrown when user aborts during retry backoff delay', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('first failure'))

    global.fetch = fetchSpy
    const controller = new AbortController()
    const f = createClient({ retries: 1, retryDelay: 10_000 })

    const promise = f('https://example.com', { signal: controller.signal })

    setTimeout(() => controller.abort(), 5)

    await expect(promise).rejects.toSatisfy(
      (err) =>
        err instanceof AbortError &&
        err.message === 'Request was aborted by user'
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('NetworkError: thrown for different network error messages', async () => {
    const nativeErr = new TypeError('NetworkError: lost connection')
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient()
    await expect(f('https://example.com')).rejects.toSatisfy((err) => {
      return err instanceof NetworkError && err.cause === nativeErr
    })
  })

  it('NetworkError: not thrown for HTTP errors', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('fail', { status: 500 }))
    const f = createClient()
    const res = await f('https://example.com')
    expect(res.status).toBe(500)
  })

  it('NetworkError: thrown when a retry fails after an earlier response', async () => {
    let calls = 0
    const onError = vi.fn()
    const onComplete = vi.fn()
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('server down', { status: 503 })
      throw new TypeError('network error')
    })
    const f = createClient({
      retries: 1,
      retryDelay: 0,
      hooks: { onError, onComplete },
    })
    await expect(f('https://example.com/retry-then-network')).rejects.toThrow(
      NetworkError
    )
    expect(calls).toBe(2)
    expect(onError).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(NetworkError)
    )
    expect(onComplete).toHaveBeenCalledWith(
      expect.any(Request),
      undefined,
      expect.any(NetworkError)
    )
  })

  it('NetworkError: not replaced by HttpError when throwOnHttpError is true', async () => {
    let calls = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('server down', { status: 503 })
      throw new TypeError('network error')
    })
    const f = createClient({
      throwOnHttpError: true,
      retries: 1,
      retryDelay: 0,
    })
    await expect(f('https://example.com/retry-then-network')).rejects.toThrow(
      NetworkError
    )
    expect(calls).toBe(2)
  })

  it('RetryLimitError: wraps last error message', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('something bad'))
    const f = createClient({ retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(RetryLimitError)
    try {
      await f('https://example.com')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryLimitError)
      if (err instanceof Error) {
        expect(err.message).toBe('something bad')
      }
    }
  })

  it('RetryLimitError: not thrown for TimeoutError', async () => {
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 20, retries: 1 })
    await expect(f('https://example.com')).rejects.toThrow(TimeoutError)
  }, 1000)

  it('CircuitOpenError: thrown after threshold, resets after timeout', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fail'))
    const f = createClient({
      retries: 0,
      plugins: [circuitPlugin({ threshold: 2, reset: 100 })],
    })
    await expect(f('https://example.com')).rejects.toThrow('fail')
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
    // Wait for reset
    await new Promise((r) => setTimeout(r, 120))
    await expect(f('https://example.com')).rejects.toThrow(CircuitOpenError)
  })

  it('Error hooks receive correct error instance', async () => {
    const onError = vi.fn()
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('NetworkError: lost connection'))
    const f = createClient({ hooks: { onError } })
    await expect(f('https://example.com')).rejects.toThrow(NetworkError)
    expect(onError).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(NetworkError)
    )
  })

  it('onTimeout and onAbort hooks are not both called', async () => {
    const onTimeout = vi.fn()
    const onAbort = vi.fn()
    global.fetch = vi.fn().mockImplementation(async (input) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    })
    const f = createClient({ timeout: 10, hooks: { onTimeout, onAbort } })
    await expect(f('https://example.com')).rejects.toThrow(TimeoutError)
    expect(onTimeout).toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
  }, 300)

  it('throws RetryLimitError with default message if error has no string message', async () => {
    global.fetch = vi.fn().mockRejectedValue(undefined) // or null, or {}
    const f = createClient({ retries: 0 })
    try {
      await f('https://example.com')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryLimitError)
      if (err instanceof Error) {
        expect(err.message).toBe('Retry limit reached')
      }
    }
  })
})

// Regression coverage for the shapes native `fetch` actually rejects with: a
// timeout rejects with a `DOMException` named "TimeoutError" (not
// "AbortError"), `abort(reason)` rejects with `reason` verbatim, and a network
// failure rejects with a `TypeError('fetch failed')` that carries the real
// reason in `cause`. None of these may fall through to `RetryLimitError`.
describe('Native fetch rejection shapes', () => {
  /**
   * Mirrors native behaviour: reject with the abort reason of the signal the
   * request was given, and never resolve otherwise.
   */
  function rejectWithSignalReason() {
    return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const signal = input instanceof Request ? input.signal : undefined
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    })
  }

  /**
   * Node rejects with `TypeError('fetch failed')` and hangs the real reason off
   * `cause`. Built with `Object.assign` because the project's `lib` is pinned to
   * ES2020, so the ES2022 `{ cause }` option of the error constructors is not
   * part of the type surface - at runtime `cause` is an own property either way,
   * which is what the classifier reads.
   */
  function fetchFailed(cause: unknown, message = 'fetch failed') {
    return Object.assign(new TypeError(message), { cause })
  }

  /**
   * The shape Node reports when several addresses were tried: one entry per
   * attempt in `errors`. Built with `Object.assign` because the `AggregateError`
   * global (ES2021) is not part of the ES2020 lib.
   */
  function allAddressesFailed(errors: unknown[], message: string) {
    return Object.assign(new Error(message), { errors })
  }

  it('classifies a native timeout as TimeoutError and does not retry it', async () => {
    global.fetch = rejectWithSignalReason()
    const onTimeout = vi.fn()
    const onAbort = vi.fn()
    const onRetry = vi.fn()
    const f = createClient({
      timeout: 20,
      retries: 2,
      hooks: { onTimeout, onAbort, onRetry },
    })

    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        err instanceof TimeoutError &&
        err instanceof Error &&
        err.cause instanceof DOMException &&
        err.cause.name === 'TimeoutError'
    )

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onAbort).not.toHaveBeenCalled()
    // The attempt must not be retried: the aborted signal would short-circuit
    // the next attempt anyway.
    expect(onRetry).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  }, 1000)

  it('classifies an abort with a custom Error reason as AbortError', async () => {
    global.fetch = rejectWithSignalReason()
    const onAbort = vi.fn()
    const onRetry = vi.fn()
    const controller = new AbortController()
    const f = createClient({
      timeout: 5_000,
      retries: 2,
      hooks: { onAbort, onRetry },
    })

    const promise = f('https://example.com', { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stop now')), 20)

    await expect(promise).rejects.toSatisfy(
      (err) =>
        err instanceof AbortError &&
        err.message === 'Request was aborted by user'
    )
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  }, 1000)

  it('classifies an abort with a string reason as AbortError', async () => {
    global.fetch = rejectWithSignalReason()
    const controller = new AbortController()
    const f = createClient({ timeout: 5_000 })

    const promise = f('https://example.com', { signal: controller.signal })
    setTimeout(() => controller.abort('cancelled by user'), 20)

    await expect(promise).rejects.toBeInstanceOf(AbortError)
  }, 1000)

  it('classifies a node-fetch style Error named AbortError as AbortError', async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('The user aborted a request.'), {
        name: 'AbortError',
      })
    )
    const f = createClient({ retries: 1 })

    await expect(f('https://example.com')).rejects.toBeInstanceOf(AbortError)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies Node connection and DNS failures as NetworkError', async () => {
    const refused = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:1'),
      { code: 'ECONNREFUSED' }
    )
    const dns = Object.assign(
      new Error('getaddrinfo ENOTFOUND does-not-exist.invalid'),
      { code: 'ENOTFOUND' }
    )

    for (const nativeErr of [
      fetchFailed(refused),
      fetchFailed(allAddressesFailed([refused], 'fetch failed')),
      fetchFailed(dns),
    ]) {
      global.fetch = vi.fn().mockRejectedValue(nativeErr)
      const f = createClient({ retries: 0 })

      await expect(f('https://example.com')).rejects.toSatisfy(
        (err) => err instanceof NetworkError && err.cause === nativeErr
      )
    }
  })

  it('keeps a non-transport fetch rejection at RetryLimitError', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          'Cannot construct a Request with a Request object that has already been used.'
        )
      )
    const f = createClient({ retries: 1, retryDelay: 0 })

    await expect(f('https://example.com')).rejects.toBeInstanceOf(
      RetryLimitError
    )
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the error a plugin raises to refuse an attempt', async () => {
    // `beforeAttempt` runs before the attempt is built, so a plugin that throws
    // there is refusing the request rather than reporting a failure of the
    // dependency. The core hands that error to the caller as it is instead of
    // re-labelling it as a `RetryLimitError`, and core `onError` stays silent
    // because the verdict is not the core's.
    const refusal = new Error('not admitted')
    const onError = vi.fn()
    const fetchHandler = vi.fn(async () => new Response('ok'))
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      fetchHandler,
      hooks: { onError },
      plugins: [
        {
          name: 'refuser',
          beforeAttempt: () => {
            throw refusal
          },
        },
      ],
    })

    await expect(f('https://example.com')).rejects.toBe(refusal)
    expect(fetchHandler).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('keeps the error a retry hook raises while deciding on a retry', async () => {
    // A retry hook is not the attempt either, so its error is never converted
    // into `RetryLimitError`.
    const attemptFailure = new Error('attempt failed')
    const hookFailure = new Error('retry decision failed')
    global.fetch = vi.fn().mockRejectedValue(attemptFailure)
    const f = createClient({
      retries: 2,
      retryDelay: 0,
      shouldRetry: () => {
        throw hookFailure
      },
    })

    await expect(f('https://example.com')).rejects.toBe(hookFailure)
  })

  it('classifies a TimeoutError-shaped DOMException even without an aborted signal', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError'
        )
      )
    const f = createClient({ retries: 1, timeout: 0 })

    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        err instanceof TimeoutError &&
        err.cause instanceof DOMException &&
        err.cause.name === 'TimeoutError'
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies a rejection named TimeoutError from another client', async () => {
    // Rejections from other HTTP clients carry the name without being a
    // `DOMException`, for example `got`'s `TimeoutError`.
    const nativeErr = Object.assign(new Error('handler timed out'), {
      name: 'TimeoutError',
    })
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const onTimeout = vi.fn()
    const f = createClient({ retries: 1, hooks: { onTimeout } })

    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        err instanceof TimeoutError &&
        err.message === 'signal timed out' &&
        err.cause === nativeErr
    )
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies network codes found behind an unrecognized message', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:1'), {
      code: 'ECONNREFUSED',
    })
    const nativeErr = fetchFailed(
      allAddressesFailed([refused], 'all addresses failed'),
      'connection failure'
    )
    global.fetch = vi.fn().mockRejectedValue(nativeErr)
    const f = createClient({ retries: 0 })

    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) => err instanceof NetworkError && err.cause === nativeErr
    )
  })

  it('skips unrelated entries while walking an errors array', async () => {
    const unrelated = new Error('address was skipped')
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:1'), {
      code: 'ECONNREFUSED',
    })
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        fetchFailed(
          allAddressesFailed([unrelated, refused], 'all addresses failed'),
          'connection failure'
        )
      )
    const f = createClient({ retries: 0 })

    await expect(f('https://example.com')).rejects.toBeInstanceOf(NetworkError)
  })

  it('stops walking a cause chain once it is unreasonably deep', async () => {
    // The depth cap keeps a cyclic or hostile rejection from being walked
    // forever, so a code buried below it counts as an application error.
    let deep: unknown = Object.assign(new Error('connect ECONNRESET'), {
      code: 'ECONNRESET',
    })
    for (let i = 0; i < 7; i++) {
      deep = Object.assign(new TypeError('wrapped'), { cause: deep })
    }
    global.fetch = vi.fn().mockRejectedValue(deep)
    const f = createClient({ retries: 0 })

    await expect(f('https://example.com')).rejects.toBeInstanceOf(
      RetryLimitError
    )
  })

  it('falls back to a generic message when the transport rejection has none', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error(''), { code: 'ECONNRESET' }))
    const f = createClient({ retries: 0 })

    await expect(f('https://example.com')).rejects.toSatisfy(
      (err) =>
        err instanceof NetworkError && err.message === 'Network error occurred'
    )
  })

  it('treats a rejection with the library AbortError as a cancellation', async () => {
    const aborted = new AbortError('handler aborted the request')
    global.fetch = vi.fn().mockRejectedValue(aborted)
    const onAbort = vi.fn()
    const f = createClient({ retries: 2, hooks: { onAbort } })

    await expect(f('https://example.com')).rejects.toBe(aborted)
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a TimeoutError rejected by a custom fetchHandler', async () => {
    // A handler that runs its own timer maps onto the library's errors, so the
    // classification has to survive instead of becoming an AbortError.
    const timedOut = new TimeoutError('handler timed out')
    global.fetch = vi.fn().mockRejectedValue(timedOut)
    const onTimeout = vi.fn()
    const onAbort = vi.fn()
    const f = createClient({ retries: 2, hooks: { onTimeout, onAbort } })

    await expect(f('https://example.com')).rejects.toBe(timedOut)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onAbort).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
