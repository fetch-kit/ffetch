import type { ClientPlugin } from '../plugins.js'
import {
  CircuitOpenError,
  HttpError,
  NetworkError,
  RetryLimitError,
  TimeoutError,
} from '../error.js'

export type CircuitPluginExtension = {
  circuitOpen: boolean
}

export type CircuitOpenReason =
  | { type: 'already-open' }
  | {
      type: 'threshold-reached'
      response?: Response
      error?: unknown
    }

export type CircuitPluginOptions = {
  threshold: number
  reset: number
  onCircuitOpen?: (ctx: {
    request: Request
    reason: CircuitOpenReason
  }) => void | Promise<void>
  onCircuitClose?: (ctx: {
    request: Request
    response: Response
  }) => void | Promise<void>
  order?: number
}

export function circuitPlugin(
  options: CircuitPluginOptions
): ClientPlugin<CircuitPluginExtension> {
  const {
    threshold,
    reset,
    onCircuitOpen,
    onCircuitClose,
    order = 20,
  } = options

  let failures = 0
  let nextAttempt = 0
  let isOpen = false

  /**
   * Statuses that count as a dependency failure. The same rule decides retries
   * (`should-retry.ts`) and is applied to a response the client returns.
   */
  const isFailureStatus = (status: number): boolean =>
    status >= 500 || status === 429

  /**
   * The response an `HttpError` carries. `throwOnHttpError` throws it with the
   * final response as `cause`, and the status is read structurally because
   * `instanceof Response` is unreliable for a response built by a custom
   * `fetchHandler` or in another realm.
   */
  const carriedResponse = (error: HttpError): Response | undefined => {
    const carried = error.cause
    if (typeof carried !== 'object' || carried === null) return undefined
    return typeof (carried as { status?: unknown }).status === 'number'
      ? (carried as Response)
      : undefined
  }

  /** What one observation says about the dependency. */
  type Classification = { failure: true } | { response: Response } | undefined

  /**
   * Classifies the response the pipeline returns. A 4xx is not a failure - even
   * when `throwOnHttpError` surfaces one as an `HttpError`, because that option
   * changes how a response reaches the pipeline, not which statuses describe a
   * broken dependency - and it resets the count the way a success does.
   */
  const classifyResponse = (response: Response): Classification =>
    isFailureStatus(response.status) ? { failure: true } : { response }

  /**
   * Classifies the error the pipeline reports. Only the dependency's own
   * failures count: a 5xx or 429 read from the response an `HttpError` carries,
   * or a `NetworkError`, `TimeoutError` or `RetryLimitError` the attempt raised.
   *
   * Everything else reports `undefined` and is ignored by omission, so an error
   * of any other type - a local admission refusal (`BulkheadFullError`), a
   * cancellation (`AbortError`), a raw rejection from a custom `fetchHandler` -
   * is never treated as evidence about the dependency. Whether an error came
   * from the attempt at all is the core's answer, which the caller reads from
   * `ctx.metadata.provenance` rather than inferring it here.
   */
  const classifyError = (error: unknown): Classification => {
    if (error instanceof HttpError) {
      const carried = carriedResponse(error)
      if (carried === undefined) return undefined
      return isFailureStatus(carried.status)
        ? { failure: true }
        : { response: carried }
    }
    if (
      error instanceof NetworkError ||
      error instanceof TimeoutError ||
      error instanceof RetryLimitError
    ) {
      return { failure: true }
    }
    return undefined
  }

  const recordSuccess = async (req: Request, response: Response) => {
    const wasOpen = isOpen
    failures = 0
    if (wasOpen) {
      isOpen = false
      await onCircuitClose?.({ request: req, response })
    }
  }

  const onFailure = async (
    req: Request,
    reason: Omit<
      Extract<CircuitOpenReason, { type: 'threshold-reached' }>,
      'type'
    >
  ): Promise<boolean> => {
    failures++
    if (failures >= threshold) {
      nextAttempt = Date.now() + reset
      isOpen = true
      await onCircuitOpen?.({
        request: req,
        reason: { type: 'threshold-reached', ...reason },
      })
      return true
    }
    return false
  }

  /**
   * Refuses a request while the circuit is open. Checked in `preRequest` so a
   * blocked request never takes a bulkhead slot, and again in `beforeAttempt`,
   * because a request can wait after the first check - in a queue, or between
   * retries - while another request opens the circuit.
   */
  const assertAdmitted = async (request: Request): Promise<void> => {
    if (Date.now() < nextAttempt) {
      await onCircuitOpen?.({ request, reason: { type: 'already-open' } })
      throw new CircuitOpenError('Circuit is open')
    }
  }

  /**
   * Applies a classification: a failure counts against the threshold and can
   * open the circuit, a non-failure response resets the counter the way a
   * success does, and an ignored observation changes nothing.
   */
  const observe = async (
    request: Request,
    decision: Classification,
    reason: Omit<
      Extract<CircuitOpenReason, { type: 'threshold-reached' }>,
      'type'
    >
  ): Promise<void> => {
    if (decision === undefined) return
    if ('response' in decision) {
      await recordSuccess(request, decision.response)
      return
    }
    if (await onFailure(request, reason)) {
      throw new CircuitOpenError('Circuit is open')
    }
  }

  return {
    name: 'circuit',
    order,
    setup: ({ defineExtension }) => {
      defineExtension('circuitOpen', {
        get: () => isOpen,
        enumerable: true,
      })
    },
    preRequest: async (ctx) => {
      await assertAdmitted(ctx.request)
    },
    /**
     * Admission is re-checked immediately before every attempt, which is the
     * only point that runs after a request has finished waiting. A request that
     * passed `preRequest` while the circuit was closed must not be dispatched
     * into a circuit that opened in the meantime, for example while it sat in a
     * bulkhead queue or in a retry delay.
     */
    beforeAttempt: async (ctx) => {
      await assertAdmitted(ctx.request)
    },
    onSuccess: async (ctx, response) => {
      await observe(ctx.request, classifyResponse(response), { response })
    },
    onError: async (ctx, error) => {
      // Only an error the attempt itself raised says anything about the
      // dependency. Local code is reported as `hook` however its error is
      // typed - a plugin refusing the request, a hook that throws, another
      // plugin's reporting hook, and this circuit's own refusal - so an error
      // type is never read as evidence about the dependency.
      if (ctx.metadata.provenance !== 'attempt') {
        return
      }
      await observe(ctx.request, classifyError(error), { error })
    },
  }
}
