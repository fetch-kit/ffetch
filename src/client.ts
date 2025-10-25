import type {
  FFetchOptions,
  FFetch,
  FFetchRequestInit,
  PendingRequest,
} from './types.js'
import { dedupeRequestHash } from './dedupeRequestHash.js'
import { retry, defaultDelay } from './retry.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import { CircuitBreaker } from './circuit.js'
import {
  TimeoutError,
  CircuitOpenError,
  AbortError,
  RetryLimitError,
  NetworkError,
} from './error.js'

export function createClient(opts: FFetchOptions = {}): FFetch {
  // Track in-flight deduped requests and their resolvers
  const dedupeMap = new Map<
    string,
    {
      promise: Promise<Response>
      resolve: (value: Response | PromiseLike<Response>) => void
      reject: (reason?: unknown) => void
    }
  >()
  const {
    timeout: clientDefaultTimeout = 5_000,
    retries: clientDefaultRetries = 0,
    retryDelay: clientDefaultRetryDelay = defaultDelay,
    shouldRetry: clientDefaultShouldRetry = defaultShouldRetry,
    hooks: clientDefaultHooks = {},
    circuit: clientDefaultCircuit,
    fetchHandler,
    dedupe = false,
    dedupeHashFn = dedupeRequestHash,
  } = opts

  const breaker = clientDefaultCircuit
    ? new CircuitBreaker(
        clientDefaultCircuit.threshold,
        clientDefaultCircuit.reset
      )
    : null

  if (
    breaker &&
    (clientDefaultHooks.onCircuitClose || clientDefaultHooks.onCircuitOpen)
  ) {
    breaker.setHooks({
      onCircuitClose: clientDefaultHooks.onCircuitClose,
      onCircuitOpen: clientDefaultHooks.onCircuitOpen,
    })
  }

  const pendingRequests: PendingRequest[] = []

  // Helper to abort all pending requests
  function abortAll() {
    for (const entry of pendingRequests) {
      entry.controller?.abort()
    }
  }

  const client = async (
    input: RequestInfo | URL,
    init: FFetchRequestInit = {}
  ) => {
    // Deduplication logic
    const effectiveDedupe =
      typeof init.dedupe !== 'undefined' ? init.dedupe : dedupe
    const effectiveDedupeHashFn = init.dedupeHashFn || dedupeHashFn
    let dedupeKey: string | undefined

    let request = new Request(input, init)
    if (effectiveDedupe) {
      dedupeKey = effectiveDedupeHashFn({
        method: request.method,
        url: request.url,
        body: init.body ?? null,
        headers: request.headers,
        signal:
          init.signal === undefined || init.signal === null
            ? undefined
            : init.signal,
        requestInit: init,
        request,
      })
      if (dedupeKey) {
        if (dedupeMap.has(dedupeKey)) {
          return dedupeMap.get(dedupeKey)!.promise
        }
        let settled = false
        let resolveFn: (value: Response | PromiseLike<Response>) => void
        let rejectFn: (reason?: unknown) => void
        const inFlightPromise = new Promise<Response>((resolve, reject) => {
          resolveFn = (value) => {
            if (!settled) {
              settled = true
              resolve(value)
            }
          }
          rejectFn = (reason) => {
            if (!settled) {
              settled = true
              reject(reason)
            }
          }
        })
        dedupeMap.set(dedupeKey, {
          promise: inFlightPromise,
          resolve: resolveFn!,
          reject: rejectFn!,
        })
      }
    }

    // Merge hooks: per-request hooks override client hooks, but fallback to client hooks
    const effectiveHooks = { ...clientDefaultHooks, ...(init.hooks || {}) }
    if (effectiveHooks.transformRequest) {
      request = await effectiveHooks.transformRequest(request)
    }
    await effectiveHooks.before?.(request)

    // Determine throwOnHttpError (per-request overrides client default)
    const effectiveThrowOnHttpError =
      typeof init.throwOnHttpError !== 'undefined'
        ? init.throwOnHttpError
        : (opts.throwOnHttpError ?? false)

    // Create timeout signal (manual implementation if AbortSignal.timeout not available)
    function createTimeoutSignal(timeout: number): AbortSignal {
      if (typeof AbortSignal?.timeout === 'function') {
        return AbortSignal.timeout(timeout)
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      controller.signal.addEventListener(
        'abort',
        () => clearTimeout(timeoutId),
        { once: true }
      )
      return controller.signal
    }

    // AbortSignal.timeout/any logic
    const effectiveTimeout = init.timeout ?? clientDefaultTimeout
    const userSignal = init.signal
    const transformedSignal = request.signal
    let timeoutSignal: AbortSignal | undefined = undefined
    let combinedSignal: AbortSignal | undefined = undefined
    let controller: AbortController | undefined = undefined

    if (effectiveTimeout > 0) {
      timeoutSignal = createTimeoutSignal(effectiveTimeout)
    }

    const signals: AbortSignal[] = []
    if (userSignal) signals.push(userSignal)
    if (transformedSignal && transformedSignal !== userSignal) {
      signals.push(transformedSignal)
    }
    if (timeoutSignal) signals.push(timeoutSignal)

    if (signals.length === 1) {
      combinedSignal = signals[0]
      controller = new AbortController()
    } else {
      if (typeof AbortSignal.any !== 'function') {
        throw new Error(
          'AbortSignal.any is required for combining multiple signals. Please install a polyfill for environments that do not support it.'
        )
      }
      combinedSignal = AbortSignal.any(signals)
      controller = new AbortController()
    }

    const retryWithHooks = async () => {
      const effectiveRetries = init.retries ?? clientDefaultRetries
      const effectiveRetryDelay =
        typeof init.retryDelay !== 'undefined'
          ? init.retryDelay
          : clientDefaultRetryDelay
      const effectiveShouldRetry = init.shouldRetry ?? clientDefaultShouldRetry

      let attempt = 0
      const shouldRetryWithHook = (ctx: import('./types').RetryContext) => {
        attempt = ctx.attempt
        const retrying = effectiveShouldRetry(ctx)
        if (retrying && attempt <= effectiveRetries) {
          effectiveHooks.onRetry?.(
            request,
            attempt - 1,
            ctx.error,
            ctx.response
          )
        }
        return retrying
      }

      let lastResponse: Response | undefined = undefined
      try {
        let res = await retry(
          async () => {
            if (userSignal?.aborted) {
              effectiveHooks.onAbort?.(request)
              throw new AbortError('Request was aborted by user')
            }
            if (timeoutSignal?.aborted) {
              effectiveHooks.onTimeout?.(request)
              throw new TimeoutError('signal timed out')
            }
            if (typeof combinedSignal?.throwIfAborted === 'function') {
              combinedSignal.throwIfAborted()
            } else if (combinedSignal?.aborted) {
              if (userSignal?.aborted) {
                effectiveHooks.onAbort?.(request)
                throw new AbortError('Request was aborted by user')
              } else if (timeoutSignal?.aborted) {
                effectiveHooks.onTimeout?.(request)
                throw new TimeoutError('signal timed out')
              } else {
                throw new AbortError(
                  'Request was aborted',
                  new DOMException('Aborted', 'AbortError')
                )
              }
            }
            const reqWithSignal = new Request(request, {
              signal: combinedSignal,
            })
            try {
              const handler = fetchHandler ?? fetch
              const response = await handler(reqWithSignal)
              lastResponse = response
              if (
                breaker &&
                (response.status >= 500 || response.status === 429)
              ) {
                breaker.recordResult(response, undefined, request)
              }
              return response
            } catch (err) {
              if (breaker) breaker.recordResult(undefined, err, request)
              if (err instanceof DOMException && err.name === 'AbortError') {
                if (
                  timeoutSignal?.aborted &&
                  (!userSignal || !userSignal.aborted)
                ) {
                  effectiveHooks.onTimeout?.(request)
                  throw new TimeoutError('signal timed out', err)
                } else if (userSignal?.aborted) {
                  effectiveHooks.onAbort?.(request)
                  throw new AbortError('Request was aborted by user')
                } else {
                  throw new AbortError(
                    'Request was aborted',
                    new DOMException('Aborted', 'AbortError')
                  )
                }
              } else if (
                err instanceof TypeError &&
                /NetworkError|network error|failed to fetch|lost connection|NetworkError when attempting to fetch resource/i.test(
                  err.message
                )
              ) {
                throw new NetworkError(err.message, err)
              }
              throw err
            }
          },
          effectiveRetries,
          effectiveRetryDelay,
          shouldRetryWithHook,
          request
        )
        if (effectiveHooks.transformResponse) {
          res = await effectiveHooks.transformResponse(res, request)
        }
        await effectiveHooks.after?.(request, res)
        await effectiveHooks.onComplete?.(request, res, undefined)
        if (
          effectiveThrowOnHttpError &&
          ((res.status >= 400 && res.status < 500 && res.status !== 429) ||
            res.status >= 500 ||
            res.status === 429)
        ) {
          const { HttpError } = await import('./error.js')
          throw new HttpError(
            `HTTP error: ${res.status} ${res.statusText}`,
            res
          )
        }
        return res
      } catch (err: unknown) {
        if (lastResponse) {
          const resp = lastResponse as Response
          if (
            effectiveThrowOnHttpError &&
            ((resp.status >= 400 && resp.status < 500 && resp.status !== 429) ||
              resp.status >= 500 ||
              resp.status === 429)
          ) {
            const { HttpError } = await import('./error.js')
            throw new HttpError(
              `HTTP error: ${resp.status} ${resp.statusText}`,
              resp
            )
          }
          return resp
        }
        if (err instanceof TimeoutError) {
          await effectiveHooks.onTimeout?.(request)
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        if (err instanceof AbortError) {
          await effectiveHooks.onAbort?.(request)
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        if (err instanceof NetworkError) {
          await effectiveHooks.onError?.(request, err)
          await effectiveHooks.onComplete?.(request, undefined, err)
          throw err
        }
        const retryErr = new RetryLimitError(
          typeof err === 'object' &&
          err &&
          'message' in err &&
          typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : 'Retry limit reached',
          err
        )
        await effectiveHooks.onError?.(request, retryErr)
        await effectiveHooks.onComplete?.(request, undefined, retryErr)
        throw retryErr
      }
    }

    const actualPromise = breaker
      ? breaker.invoke(retryWithHooks).catch(async (err: unknown) => {
          if (err instanceof CircuitOpenError) {
            await effectiveHooks.onCircuitOpen?.(request)
            await effectiveHooks.onError?.(request, err)
            await effectiveHooks.onComplete?.(request, undefined, err)
          } else {
            await effectiveHooks.onError?.(request, err)
            await effectiveHooks.onComplete?.(request, undefined, err)
          }
          throw err
        })
      : retryWithHooks()

    // If deduplication is enabled and dedupeKey is set, resolve/reject the in-flight promise
    if (effectiveDedupe && dedupeKey && dedupeMap.has(dedupeKey)) {
      const entry = dedupeMap.get(dedupeKey)
      if (entry) {
        actualPromise.then(
          (result) => entry.resolve(result),
          (error) => entry.reject(error)
        )
        // Replace the placeholder with the actual promise for future requests
        dedupeMap.set(dedupeKey, {
          promise: actualPromise,
          resolve: entry.resolve,
          reject: entry.reject,
        })
      }
    }

    const pendingEntry: PendingRequest = {
      promise: actualPromise,
      request,
      controller,
    }
    pendingRequests.push(pendingEntry)

    return actualPromise.finally(() => {
      const index = pendingRequests.indexOf(pendingEntry)
      if (index > -1) {
        pendingRequests.splice(index, 1)
      }
      // Only delete dedupeMap entry if the promise is the same as the one in the map
      if (
        effectiveDedupe &&
        dedupeKey &&
        dedupeMap.get(dedupeKey)?.promise === actualPromise
      ) {
        dedupeMap.delete(dedupeKey)
      }
    })
  }

  Object.defineProperty(client, 'pendingRequests', {
    get() {
      return pendingRequests
    },
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(client, 'abortAll', {
    value: abortAll,
    writable: false,
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(client, 'circuitOpen', {
    get() {
      return breaker ? breaker.open : false
    },
    enumerable: true,
  })

  return client as FFetch
}
