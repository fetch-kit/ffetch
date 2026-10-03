import { AbortError, NetworkError, TimeoutError } from '../error.js'
import { isSignalAborted } from './signals.js'
import {
  isCancellationReason,
  isTransportError,
  rejectionName,
} from './transport-error.js'
import type {
  PluginExtensionBase,
  PluginProvenance,
  PluginRequestContext,
  PluginRequestPromiseExtensionBase,
  ClientPlugin,
} from '../plugins.js'

type AnyPlugin = ClientPlugin<
  PluginExtensionBase,
  PluginRequestPromiseExtensionBase
>

/**
 * Who raised the error the request is propagating. The core marks the errors it
 * raises for the attempt, and marks the call sites where a hook can raise one
 * instead, so an error thrown by local code is never mistaken for the attempt
 * failing - not even when a hook throws the attempt's own error onward, which
 * identity cannot tell apart.
 *
 * This is the only place the marker is written, and it mirrors
 * `metadata.provenance`, which is what plugins read.
 */
export interface AttemptState {
  provenance: PluginProvenance
}

export function createAttemptState(): AttemptState {
  return { provenance: 'hook' }
}

/**
 * Records who raised the error being propagated, for plugins and for the
 * pipeline that decides what the caller sees.
 */
export function markProvenance(
  state: AttemptState,
  context: PluginRequestContext,
  provenance: PluginProvenance
): void {
  state.provenance = provenance
  markContextProvenance(context, provenance)
}

/**
 * Records who raised an error a context is reporting, for plugins to read. The
 * pipeline uses this for the outcome it reports itself - a plugin failing while
 * being told about the response, for example - which is never an attempt's.
 */
export function markContextProvenance(
  context: PluginRequestContext,
  provenance: PluginProvenance
): void {
  context.metadata.provenance = provenance
}

/**
 * Runs local code - a hook, or a retry policy - and marks whatever it throws as
 * local code's error rather than the attempt's.
 */
export async function runLocal<T>(
  state: AttemptState,
  context: PluginRequestContext,
  run: () => T | Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    markProvenance(state, context, 'hook')
    throw err
  }
}

/**
 * Runs everything an attempt raises as the attempt's own outcome: the signals
 * it is dispatched with, the request built for it, and whatever the handler
 * rejects with. Only the hooks called inside are local code.
 */
async function runAsAttempt<T>(
  state: AttemptState,
  context: PluginRequestContext,
  run: () => Promise<T>
): Promise<T> {
  markProvenance(state, context, 'attempt')
  return run()
}

/** The signals an attempt is dispatched with, and what a cancellation is read from. */
export interface AttemptSignals {
  /** The pipeline's own controller, aborted by `abortAll()`. */
  controller: AbortController
  /** The signal the caller passed, if any. */
  userSignal?: AbortSignal | null
  /** The timeout signal, when the request has a timeout. */
  timeoutSignal?: AbortSignal
  /** The signal the dispatch was called with, which a plugin can replace. */
  dispatchSignal?: AbortSignal
}

/**
 * The error to raise for a request that is already cancelled, read from the
 * signals rather than from a rejection: it is checked before the request is
 * built, so nothing has been dispatched yet.
 */
export function cancelledSignalError(
  signals: AttemptSignals
): AbortError | TimeoutError | undefined {
  const { controller, userSignal, timeoutSignal, dispatchSignal } = signals
  if (controller.signal.aborted) {
    return new AbortError('Request was aborted')
  }
  if (userSignal?.aborted) {
    return new AbortError('Request was aborted by user')
  }
  if (timeoutSignal?.aborted) {
    return new TimeoutError('signal timed out')
  }
  if (dispatchSignal?.aborted) {
    if (userSignal?.aborted) {
      return new AbortError('Request was aborted by user')
    } else if (timeoutSignal?.aborted) {
      return new TimeoutError('signal timed out')
    } else {
      return new AbortError('Request was aborted', dispatchSignal.reason)
    }
  }
  return undefined
}

/**
 * The error a rejected attempt is reported as.
 *
 * Cancellation is read from the signals as well as from the rejection value:
 * `fetch` rejects with the abort reason of the signal it was given, which is a
 * `DOMException` named `TimeoutError` for a timeout and the value passed to
 * `abort(reason)` - possibly a string - for a user abort. The signals are what
 * tell the two apart, and the caller's abort wins over the timeout.
 *
 * A transport failure is reported as a `NetworkError`, because it is the only
 * failure that says the request never reached the dependency. Everything else
 * is passed on as it was raised.
 */
export function classifyAttemptFailure(
  err: unknown,
  signals: AttemptSignals
): unknown {
  const { controller, userSignal, timeoutSignal, dispatchSignal } = signals
  const cancelled =
    isCancellationReason(err) ||
    isSignalAborted(timeoutSignal) ||
    isSignalAborted(userSignal) ||
    isSignalAborted(controller.signal) ||
    isSignalAborted(dispatchSignal)

  if (cancelled) {
    if (timeoutSignal?.aborted && (!userSignal || !userSignal.aborted)) {
      return new TimeoutError('signal timed out', err)
    } else if (userSignal?.aborted) {
      return new AbortError('Request was aborted by user')
    } else if (controller.signal.aborted) {
      return new AbortError('Request was aborted', err)
    } else if (err instanceof TimeoutError || err instanceof AbortError) {
      // A custom `fetchHandler` can reject with the library's own errors, for
      // example after running its own timer. Keep them as they are - re-wrapping
      // would turn a `TimeoutError` into an `AbortError` and rewrite the message
      // and the cause.
      return err
    } else if (rejectionName(err) === 'TimeoutError') {
      // Any other shape that names itself as a timeout, for example the
      // `DOMException` from `AbortSignal.timeout()`.
      return new TimeoutError('signal timed out', err)
    } else {
      return new AbortError('Request was aborted', err)
    }
  }

  if (isTransportError(err)) {
    return new NetworkError(
      err instanceof Error && err.message
        ? err.message
        : 'Network error occurred',
      err
    )
  }
  return err
}

/** Everything an attempt needs to run, resolved once by the pipeline. */
export interface AttemptContext {
  /** The request the attempt is built from. */
  request: Request
  /** The body captured for a request that can be re-sent, or `null`. */
  body: Uint8Array | null
  /** The context the attempt runs for: what the hooks and metadata see. */
  context: PluginRequestContext
  /** The signals the attempt is dispatched with. */
  signals: AttemptSignals
  /** The plugins whose `beforeAttempt` hooks run for the attempt. */
  plugins: readonly AnyPlugin[]
  /** The handler the request is dispatched with. */
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Who raised the error the attempt is propagating. */
  state: AttemptState
}

/**
 * Runs one attempt and returns the response it produced, or throws the error it
 * failed with, classified for the caller.
 */
export async function runAttempt(
  attempt: AttemptContext,
  number: number
): Promise<Response> {
  return runAsAttempt(attempt.state, attempt.context, async () => {
    const { context, signals } = attempt

    const cancelled = cancelledSignalError(signals)
    if (cancelled) throw cancelled

    // A plugin can refuse an attempt by throwing here - when the request is no
    // longer admitted, for example. That happens before the attempt is built,
    // so it is not a failed attempt: the plugin's error is the answer the
    // request gets.
    for (const plugin of attempt.plugins) {
      await runLocal(attempt.state, context, () =>
        plugin.beforeAttempt?.(context, number)
      )
    }

    try {
      const reqWithSignal =
        attempt.body === null
          ? new Request(attempt.request.clone(), {
              signal: signals.dispatchSignal,
            })
          : new Request(attempt.request, {
              signal: signals.dispatchSignal,
              body: attempt.body.slice(),
            })
      const response = await attempt.handler(reqWithSignal)
      context.metadata.retry.lastResponse = response
      return response
    } catch (err) {
      context.metadata.retry.lastError = err
      // Building the request for the attempt counts as part of it: either way
      // this is the error the attempt failed with, which the provenance marker
      // already records.
      throw classifyAttemptFailure(err, signals)
    }
  })
}
