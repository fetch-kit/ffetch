import type { RetryContext } from '../types.js'
import type { PluginRetryMetadata } from '../plugins.js'
import type { RetryDelay } from '../retry.js'

/**
 * One attempt list: the attempts themselves, the decision that re-sends one, and
 * the wait between them. Everything that makes a retry sequence observable is
 * run from here - the attempt numbers, the retry metadata plugins read, the
 * `onRetry` hook, and the response a retry discards - so the pipeline and a
 * plugin that dispatches the request again cannot drift apart in how they retry.
 */
export interface RetrySequence {
  /** Runs one attempt, numbered from 1. */
  attempt: (number: number) => Promise<Response>
  /** How many times an attempt is re-sent before the sequence gives up. */
  retries: number
  /** How long to wait before an attempt is re-sent. */
  delay: RetryDelay
  /**
   * The request the attempts are built from: what the decision and the hook
   * describe, and the request the attempts are numbered against.
   */
  request: Request
  /**
   * The retry metadata the sequence keeps up to date, as plugins read it. Every
   * attempt is recorded, the last one the budget allows included, so what
   * plugins read while the request settles describes the attempt that ran.
   */
  metadata: PluginRetryMetadata
  /**
   * Whether the attempt that just finished is re-sent. When left out, every
   * attempt is re-sent until the budget runs out.
   */
  decide?: (ctx: RetryContext) => boolean | Promise<boolean>
  /**
   * Runs before a re-sent attempt, after the decision, with the request, the
   * error or the response of the attempt that finished, and that attempt's
   * zero-based retry number - the `onRetry` contract, where `0` is the first
   * retry. The hook is never told about a retry that does not happen.
   */
  onRetry?: (
    request: Request,
    attempt: number,
    error: unknown,
    response?: Response
  ) => void | Promise<void>
  /**
   * Runs the code the sequence calls that is not the attempt itself - the
   * decision and the retry hook - so what it throws is marked as local code's
   * error rather than the attempt's. The pipeline passes `runLocal`, which is
   * what keeps a policy that rethrows the attempt's own error from being read as
   * the attempt failing.
   */
  local?: <T>(run: () => T | Promise<T>) => Promise<T>
  /**
   * The signal the wait between attempts listens to, so cancelling the request
   * ends a wait that will never be used.
   */
  signal?: AbortSignal
}

/** Runs local code for a caller that has no provenance to record. */
async function runDirect<T>(run: () => T | Promise<T>): Promise<T> {
  return run()
}

/**
 * Waits out a retry delay, cut short when the request settles - the delay of a
 * retry that is no longer wanted is not waited out.
 */
function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }

    if (signal.aborted) {
      resolve()
      return
    }

    const onAbort = () => {
      // A wait that ended because the request settled still has a timer left,
      // which would otherwise fire after the request is over.
      clearTimeout(timer)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs an attempt list and returns the response it ended with, or throws the
 * error it failed with. The sequence reports what happened, not what it means:
 * classifying the error and reporting it to the caller stays with the pipeline.
 */
export async function runRetrySequence(
  sequence: RetrySequence
): Promise<Response> {
  const {
    attempt,
    retries,
    delay,
    request,
    metadata,
    decide = () => true,
    onRetry,
    local = runDirect,
    signal,
  } = sequence

  /**
   * Records the attempt that just finished where plugins read it. Every attempt
   * is recorded, the last one the budget allows included: that attempt decides
   * how the request ends, so a plugin that reads the metadata while it settles
   * has to see it.
   *
   * `shouldRetryResult` starts out unset because this attempt has not been
   * offered for a retry yet - the answer belongs to the attempt it was asked
   * about, not to the one after it.
   */
  const record = (ctx: RetryContext) => {
    metadata.attempt = ctx.attempt
    metadata.lastError = ctx.error
    metadata.lastResponse = ctx.response
    metadata.shouldRetryResult = undefined
  }

  /**
   * Asks whether the attempt that just finished is re-sent, and records the
   * answer in the metadata plugins read.
   *
   * Deciding is local code's job, so an error raised here is local code's, even
   * when the decision or the hook throws the attempt's own error onward.
   */
  const offerRetry = async (ctx: RetryContext): Promise<boolean> => {
    const retrying = await local(() => decide(ctx))
    metadata.shouldRetryResult = retrying
    if (retrying) {
      await local(() =>
        onRetry?.(request, ctx.attempt - 1, ctx.error, ctx.response)
      )
      // A response that is discarded for a retry is never read, so its body is
      // released instead of left to stream.
      const body = ctx.response?.body
      if (body) void body.cancel().catch(() => {})
    }
    return retrying
  }

  let lastErr: unknown
  let lastRes: Response | undefined

  for (let i = 0; i <= retries; i++) {
    // An attempt either fails or produces a response, so the context is only
    // ever given that attempt's own outcome: a response an earlier attempt left
    // behind is not passed on as if it were this attempt's, or a policy that
    // reads the response would decide on a response that is no longer the
    // answer.
    const ctx: RetryContext = { attempt: i + 1, request }

    try {
      lastRes = await attempt(i + 1)
    } catch (err) {
      lastErr = err
      ctx.error = err
      record(ctx)
      // The last attempt the budget allows is never offered for a retry.
      if (i === retries || !(await offerRetry(ctx))) throw err
      const wait = typeof delay === 'function' ? delay(ctx) : delay
      await waitForRetryDelay(wait, signal)
      continue
    }

    ctx.response = lastRes
    record(ctx)
    if (i < retries && (await offerRetry(ctx))) {
      const wait = typeof delay === 'function' ? delay(ctx) : delay
      await waitForRetryDelay(wait, signal)
      continue
    }
    return lastRes
  }

  // A budget that never counts out - `retries` is `NaN` - runs no attempt, and
  // ends the way it ended when the loop it replaced never ran either.
  /* v8 ignore next */
  throw lastErr
}
