import { CircuitOpenError, RetryLimitError } from './error.js'

export class CircuitBreaker {
  private failures = 0
  private nextAttempt = 0
  private isOpen = false

  // Returns true if the circuit breaker is currently open (blocking requests).
  get open(): boolean {
    return this.isOpen
  }
  private hooks?: {
    onCircuitOpen?: (req: Request) => void | Promise<void>
    onCircuitClose?: (req: Request) => void | Promise<void>
  }
  private lastSuccessRequest?: Request
  private lastOpenRequest?: Request

  constructor(
    private threshold: number,
    private resetTimeout: number
  ) {}

  // Call this after each request to record the result and update circuit state.
  // Returns true if the result was counted as a failure.
  recordResult(response?: Response, error?: unknown, req?: Request): boolean {
    // Count thrown errors (network, abort, timeout) as failures
    if (error && !(error instanceof RetryLimitError)) {
      this.setLastOpenRequest(req!)
      this.onFailure()
      return true
    }
    // Count HTTP 5xx and 429 responses as failures
    if (response && (response.status >= 500 || response.status === 429)) {
      this.setLastOpenRequest(req!)
      this.onFailure()
      return true
    }
    // Otherwise, count as success
    if (req) this.setLastSuccessRequest(req)
    this.onSuccess()
    return false
  }

  setHooks(hooks: {
    onCircuitOpen?: (req: Request) => void | Promise<void>
    onCircuitClose?: (req: Request) => void | Promise<void>
  }) {
    this.hooks = hooks
  }
  setLastOpenRequest(req: Request) {
    this.lastOpenRequest = req
  }

  setLastSuccessRequest(req: Request) {
    this.lastSuccessRequest = req
  }

  async invoke<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.nextAttempt)
      throw new CircuitOpenError('Circuit is open')
    try {
      const res = await fn()
      this.onSuccess()
      return res
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onSuccess() {
    const wasOpen = this.isOpen
    this.failures = 0
    if (wasOpen) {
      this.isOpen = false
      if (this.hooks?.onCircuitClose && this.lastSuccessRequest) {
        this.hooks.onCircuitClose(this.lastSuccessRequest)
      }
    }
    this.lastSuccessRequest = undefined
  }

  private onFailure() {
    this.failures++
    if (this.failures >= this.threshold) {
      this.nextAttempt = Date.now() + this.resetTimeout
      this.isOpen = true
      if (this.hooks?.onCircuitOpen && this.lastOpenRequest) {
        this.hooks.onCircuitOpen(this.lastOpenRequest)
      }
    }
  }
}
