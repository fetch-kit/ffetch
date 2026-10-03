/**
 * The signal a request times out on, built from the platform's
 * `AbortSignal.timeout` when it has one and from a manual timer otherwise.
 */
export function createTimeoutSignal(timeout: number): AbortSignal {
  if (typeof AbortSignal?.timeout === 'function') {
    return AbortSignal.timeout(timeout)
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  controller.signal.addEventListener('abort', () => clearTimeout(timeoutId), {
    once: true,
  })
  return controller.signal
}

/**
 * Combines the signals a request is dispatched with. The pipeline's own
 * controller always joins the caller's and the timeout signals, so there is
 * always more than one signal to combine, and `AbortSignal.any` drops
 * duplicates, so a repeated signal is harmless.
 */
export function combineRequestSignals(
  signals: (AbortSignal | undefined | null)[]
): AbortSignal {
  const combined = signals.filter(
    (signal): signal is AbortSignal => signal != null
  )
  if (typeof AbortSignal.any !== 'function') {
    throw new Error(
      'AbortSignal.any is required for combining multiple signals. Please install a polyfill for environments that do not support it.'
    )
  }
  return AbortSignal.any(combined)
}

/** Tolerates a missing signal, so a call site can list every signal it has. */
export function isSignalAborted(
  signal: AbortSignal | null | undefined
): boolean {
  return signal?.aborted === true
}
