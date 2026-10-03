import type {
  CoreClientOptions,
  FFetchRequestInit,
  PendingRequest,
  RetryContext,
} from '../types.js'
import type { Hooks } from '../hooks.js'
import type {
  ClientPlugin,
  PluginDispatch,
  PluginExtensionBase,
  PluginRequestContext,
  PluginRequestPromiseExtensionBase,
} from '../plugins.js'
import type { RetryDelay } from '../retry.js'
import { AbortError, RetryLimitError } from '../error.js'
import { isCoreError, isHttpErrorStatus } from './core-error.js'
import { canReplayBody, captureReplayableBody } from './replay-body.js'
import { runRetrySequence } from './retry-execution.js'
import { combineRequestSignals, createTimeoutSignal } from './signals.js'
import {
  createAttemptState,
  markContextProvenance,
  runAttempt,
  runLocal,
  type AttemptContext,
  type AttemptSignals,
} from './attempts.js'
import {
  callComplete,
  createLifecycleState,
  reportCoreError,
  runOnError,
  runOnFinally,
  runOnSuccess,
  type LifecycleState,
} from './lifecycle.js'

type AnyPlugin = ClientPlugin<
  PluginExtensionBase,
  PluginRequestPromiseExtensionBase
>

/** The client-level defaults a request starts from. */
export interface PipelineDefaults {
  /** How long a request may take before it times out, in milliseconds. */
  timeout: number
  /** How many times a failed attempt is re-sent. */
  retries: number
  /** How long to wait before an attempt is re-sent. */
  retryDelay: RetryDelay
  /** Whether a failed attempt is re-sent. */
  shouldRetry: (ctx: RetryContext) => boolean
  /** The hooks every request runs. */
  hooks: Hooks
}

/** What the pipeline needs from the client it runs for. */
export interface PipelineRuntime {
  /** The plugins, in the order their hooks run. */
  plugins: readonly AnyPlugin[]
  defaults: PipelineDefaults
  /** The client's live request registry, which the pipeline registers into. */
  pendingRequests: PendingRequest[]
  /** The handler requests are dispatched with, when the client sets one. */
  fetchHandler?: CoreClientOptions['fetchHandler']
  /** The client's `throwOnHttpError` default. */
  throwOnHttpError: boolean
}

/**
 * One request, from the call to the response: the request being prepared, the
 * context plugins see, and the entry `pendingRequests` and `abortAll()` read.
 * Keeping them on one object is what lets the stages below share state without
 * a closure per variable, and makes it visible which of them are written by
 * more than one stage.
 */
interface RequestRun {
  input: RequestInfo | URL
  init: FFetchRequestInit
  hooks: Hooks
  request: Request
  controller: AbortController
  context: PluginRequestContext
  lifecycle: LifecycleState
  /**
   * Whether the plugins have been given the request. A request that fails
   * before it has been through the preparation hooks is one no plugin has seen,
   * and its failure is reported to the core hooks only.
   */
  admitted: boolean
  entry?: PendingRequest
  cancelPreparation?: (error: AbortError) => void
  watchedSignals: AbortSignal[]
}

/**
 * Runs one request: prepares it, dispatches it, and reports how it settled. The
 * promise it returns is the one the caller sees, and the one the client
 * decorates.
 */
export function runRequest(
  runtime: PipelineRuntime,
  input: RequestInfo | URL,
  init: FFetchRequestInit = {}
): Promise<Response> {
  return executeRequest(runtime, input, init)
}

/**
 * The body of a call. It runs as an async function, so an error raised while
 * the request is being built - an invalid body for a `GET`, for example -
 * reaches the caller as a rejection, and no hook is told about a request that
 * does not exist.
 */
async function executeRequest(
  runtime: PipelineRuntime,
  input: RequestInfo | URL,
  init: FFetchRequestInit
): Promise<Response> {
  const { plugins, defaults, pendingRequests } = runtime
  const controller = new AbortController()
  const hooks: Hooks = { ...defaults.hooks, ...(init.hooks || {}) }

  // Every option is resolved, and the context allocated, before the request
  // reaches a hook: the metadata a plugin reads describes the request as it was
  // configured, and there is no window in which the pipeline has a request and
  // no context to describe it.
  const effectiveRetries = init.retries ?? defaults.retries
  const effectiveRetryDelay =
    typeof init.retryDelay !== 'undefined'
      ? init.retryDelay
      : defaults.retryDelay
  const effectiveShouldRetry = init.shouldRetry ?? defaults.shouldRetry
  const effectiveTimeout = init.timeout ?? defaults.timeout
  const effectiveThrowOnHttpError =
    typeof init.throwOnHttpError !== 'undefined'
      ? init.throwOnHttpError
      : runtime.throwOnHttpError
  const userSignal = init.signal

  const initialRequest = new Request(input, init)
  const context: PluginRequestContext = {
    request: initialRequest,
    init,
    state: Object.create(null),
    metadata: {
      startedAt: Date.now(),
      timeoutMs: effectiveTimeout,
      signals: {
        user:
          userSignal === undefined || userSignal === null
            ? undefined
            : userSignal,
        transformed: initialRequest.signal,
      },
      retry: {
        configuredRetries: effectiveRetries,
        configuredDelay: effectiveRetryDelay,
        attempt: 0,
      },
      // Nothing has reached the dependency yet.
      provenance: 'hook',
    },
  }

  const run: RequestRun = {
    input,
    init,
    hooks,
    request: initialRequest,
    controller,
    context,
    lifecycle: createLifecycleState(),
    admitted: false,
    watchedSignals: [],
  }

  // The request is cancelled through its preparation: a hook that is stuck, or
  // a signal that is already aborted, rejects the race below instead of
  // keeping the caller waiting for a request that is no longer wanted.
  const cancellation = new Promise<never>((_resolve, reject) => {
    run.cancelPreparation = reject
  })

  const cancellationError = () =>
    init.signal?.aborted
      ? new AbortError('Request was aborted by user')
      : new AbortError('Request was aborted', run.request.signal.reason)

  const onCancellation = () => {
    run.cancelPreparation?.(cancellationError())
  }

  const stopWatching = () => {
    for (const signal of run.watchedSignals) {
      signal.removeEventListener('abort', onCancellation)
    }
    run.watchedSignals.length = 0
    run.cancelPreparation = undefined
  }

  const watchSignal = (signal?: AbortSignal | null) => {
    if (!signal || run.watchedSignals.includes(signal)) return
    run.watchedSignals.push(signal)
    if (signal.aborted) onCancellation()
    else signal.addEventListener('abort', onCancellation)
  }

  /**
   * Adopts a request a hook replaced the original with: it becomes the request
   * the pipeline describes, the one a monitor reads from `pendingRequests`, and
   * the one whose signal is watched.
   */
  const replaceRequest = (replacement: Request) => {
    run.request = replacement
    context.request = replacement
    context.metadata.signals.transformed = replacement.signal
    // The entry is registered before preparation resolves, so the request a
    // monitor reads stays the one that is being prepared.
    run.entry!.request = replacement
    // A replacement request can carry a signal of its own.
    watchSignal(replacement.signal)
  }

  // Preparation and dispatch share one lifecycle boundary. A hook that fails
  // before the request is dispatched used to reject past the whole pipeline,
  // which skipped core `onComplete` and plugin `onError`/`onFinally` - the
  // lifecycle callbacks a caller relies on to release what it allocated.
  const preparation = (async () => {
    watchSignal(init.signal)
    watchSignal(run.request.signal)
    watchSignal(controller.signal)

    if (hooks.transformRequest) {
      replaceRequest(await hooks.transformRequest(run.request))
    }
    await hooks.before?.(run.request)

    // Only a request that can be retried needs a re-sendable body, and only a
    // body ffetch owns can be copied without stalling an upload.
    const replayableBody =
      effectiveRetries > 0 &&
      canReplayBody(input, init, hooks.transformRequest !== undefined)
        ? await captureReplayableBody(run.request)
        : null

    // The plugins are handed the request from here on. `startedAt` is recorded
    // at this boundary rather than when the context was allocated, so a slow
    // preparation hook does not shift the elapsed time a plugin computes from
    // it.
    context.metadata.startedAt = Date.now()

    // A hook that fails later is reported to the plugins, while a hook that
    // failed already - while the replayable body was still being copied, for
    // example - is reported to the core hooks alone.
    run.admitted = true

    for (const plugin of plugins) {
      await plugin.preRequest?.(context)
    }

    // AbortSignal.timeout/any logic
    const timeoutSignal =
      effectiveTimeout > 0 ? createTimeoutSignal(effectiveTimeout) : undefined
    if (timeoutSignal) {
      context.metadata.signals.timeout = timeoutSignal
    }
    // A request is dispatched with the signals it is subject to, combined into
    // one, so a plugin that dispatches with a signal of its own can still tell
    // why an attempt was cancelled.
    const combinedSignal = combineRequestSignals([
      userSignal,
      run.request.signal,
      timeoutSignal,
      controller.signal,
    ])
    context.metadata.signals.combined = combinedSignal

    /**
     * Runs the request's attempts and the hooks around them. Bound to the
     * context and the signal it is dispatched with, because a plugin can
     * dispatch the request again with a request or a signal of its own.
     */
    const retryWithHooks = async (
      dispatchCtx: PluginRequestContext,
      dispatchSignal: AbortSignal | undefined
    ) => {
      // The request the attempts are built from: a plugin that replaced the
      // request replaced the attempts with it.
      const requestForAttempt = dispatchCtx.request
      // A captured body only fits the request it was captured from. Once a
      // plugin replaces that request, each attempt builds its own body again.
      const attemptBody =
        dispatchCtx.request === run.request ? replayableBody : null
      const state = createAttemptState()

      const signals: AttemptSignals = {
        controller,
        userSignal,
        timeoutSignal,
        dispatchSignal,
      }
      const attemptRun: AttemptContext = {
        request: requestForAttempt,
        body: attemptBody,
        context: dispatchCtx,
        signals,
        plugins,
        handler: init.fetchHandler ?? runtime.fetchHandler ?? fetch,
        state,
      }

      let res: Response
      try {
        // The attempt list runs in one place: the loop, the attempt numbers,
        // the decision, the hook and the wait, so how a retry runs cannot drift
        // from how it is reported.
        res = await runRetrySequence({
          attempt: (number) => runAttempt(attemptRun, number),
          retries: effectiveRetries,
          delay: effectiveRetryDelay,
          request: requestForAttempt,
          metadata: dispatchCtx.metadata.retry,
          decide: effectiveShouldRetry,
          onRetry: hooks.onRetry,
          local: (run) => runLocal(state, dispatchCtx, run),
          signal: dispatchSignal,
        })
      } catch (err: unknown) {
        dispatchCtx.metadata.retry.lastError = err
        // Errors the core raises for the request keep their identity, and are
        // the ones the lifecycle hooks describe.
        if (isCoreError(err)) {
          if (dispatchCtx === context) {
            await reportCoreError(run.lifecycle, hooks, err, requestForAttempt)
          }
          throw err
        }
        // An error the attempt did not raise - a plugin refusing the request, a
        // retry policy or hook that threw - reaches the caller as it was
        // raised. Re-labelling it as a `RetryLimitError` would make the
        // dependency the reason for a decision it never made.
        if (state.provenance !== 'attempt') throw err
        const retryErr = new RetryLimitError(
          typeof err === 'object' &&
            err &&
            'message' in err &&
            typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : 'Retry limit reached',
          err
        )
        if (dispatchCtx === context) {
          await reportCoreError(
            run.lifecycle,
            hooks,
            retryErr,
            requestForAttempt
          )
        }
        throw retryErr
      }

      const transformResponse = hooks.transformResponse
      if (transformResponse) {
        // Rewriting the response is local code, so an error thrown while it
        // runs is not the attempt failing.
        res = await runLocal(state, dispatchCtx, () =>
          transformResponse(res, requestForAttempt)
        )
      }
      await runLocal(state, dispatchCtx, () =>
        hooks.after?.(requestForAttempt, res)
      )
      // The status is read from the response the attempt produced, so this
      // error keeps the provenance the attempt set.
      if (effectiveThrowOnHttpError && isHttpErrorStatus(res.status)) {
        const { HttpError } = await import('../error.js')
        throw new HttpError(`HTTP error: ${res.status} ${res.statusText}`, res)
      }
      return res
    }

    const baseDispatch: PluginDispatch = async (ctx) => {
      const dispatchSignal =
        ctx === context ? combinedSignal : ctx.request.signal
      return retryWithHooks(ctx, dispatchSignal)
    }

    let dispatch = baseDispatch
    for (let i = plugins.length - 1; i >= 0; i--) {
      const plugin = plugins[i]
      if (plugin.wrapDispatch) {
        dispatch = plugin.wrapDispatch(dispatch)
      }
    }

    // Bound to the context it was built for. Running it is what reaches the
    // network, so a preparation that was cancelled never runs it.
    return () => dispatch(context)
  })()

  // Dispatch runs only once preparation settled, and a cancelled preparation
  // settles here instead of waiting for the hook that is stuck.
  const prepared = Promise.race([preparation, cancellation])
    .then((dispatch) => dispatch())
    .finally(stopWatching)
    .then(async (response) => {
      try {
        await callComplete(
          run.lifecycle,
          hooks,
          run.request,
          response,
          undefined
        )
        // A response can only come out of the pipeline, and the context is
        // built before the pipeline runs, which is what describes it here.
        await runOnSuccess(plugins, context, response)
      } catch (err) {
        // Reporting the response is local code too, so a plugin that fails
        // while being told about it is not evidence about the dependency when
        // the other plugins hear about that failure.
        markContextProvenance(context, 'hook')
        throw err
      }
      return response
    })
    .catch(async (err: unknown) => {
      await reportCoreError(run.lifecycle, hooks, err, run.request)
      await callComplete(run.lifecycle, hooks, run.request, undefined, err)
      // Every plugin hears about the failure, and the first hook that fails
      // decides what the caller sees: a plugin reports an open circuit by
      // throwing from `onError`, so that error has to win over the failure it
      // replaces. A request that failed before the plugins were given it is
      // reported to the core hooks alone - the pipeline never started, so no
      // plugin ever saw the request.
      if (run.admitted) {
        const onError = await runOnError(plugins, context, err)
        if (onError.failed) {
          throw onError.error
        }
      }
      throw err
    })

  const entry: PendingRequest = {
    promise: prepared,
    request: run.request,
    controller,
  }
  run.entry = entry
  pendingRequests.push(entry)

  /**
   * Teardown. Every plugin gets `onFinally` and the entry always leaves
   * `pendingRequests`, even when a hook throws, so a failing cleanup hook
   * cannot leak the request.
   *
   * A request that already failed keeps its error, while a request that
   * succeeded still fails when an `onFinally` hook throws: the first hook
   * error is thrown only where `propagateHookError` is set, which is the
   * success path.
   */
  const runFinally = async (propagateHookError: boolean) => {
    // A request that never reached the plugins has no cleanup hook to run: what
    // was never handed out is not handed back.
    const onFinally = run.admitted
      ? await runOnFinally(plugins, context)
      : { failed: false, error: undefined }

    // The entry is registered before preparation settles and taken out once, by
    // the request that registered it, so it is always here to remove.
    const index = pendingRequests.indexOf(entry)
    /* v8 ignore else */
    if (index > -1) {
      pendingRequests.splice(index, 1)
    }

    if (onFinally.failed && propagateHookError) {
      throw onFinally.error
    }
  }

  return prepared.then(
    (response) => runFinally(true).then(() => response),
    (error) =>
      runFinally(false).then(() => {
        throw error
      })
  )
}
