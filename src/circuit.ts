import { CircuitOpenError } from './error.js'

export class CircuitBreaker {
  private failures = 0
  private nextAttempt = 0

  constructor(
    private threshold: number,
    private resetTimeout: number
  ) {}

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
    this.failures = 0
  }

  private onFailure() {
    this.failures++
    if (this.failures >= this.threshold) {
      this.nextAttempt = Date.now() + this.resetTimeout
    }
  }
}
