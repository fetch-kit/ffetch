// Custom error classes

export class TimeoutError extends Error {
  public cause?: unknown
  constructor(message = 'Request timed out', cause?: unknown) {
    super(message)
    this.name = 'TimeoutError'
    if (cause !== undefined) this.cause = cause
  }
}

export class CircuitOpenError extends Error {
  public cause?: unknown
  constructor(message = 'Circuit is open', cause?: unknown) {
    super(message)
    this.name = 'CircuitOpenError'
    if (cause !== undefined) this.cause = cause
  }
}

export class AbortError extends Error {
  public cause?: unknown
  constructor(message = 'Request was aborted', cause?: unknown) {
    super(message)
    this.name = 'AbortError'
    if (cause !== undefined) this.cause = cause
  }
}

export class RetryLimitError extends Error {
  public cause?: unknown
  constructor(message = 'Retry limit reached', cause?: unknown) {
    super(message)
    this.name = 'RetryLimitError'
    if (cause !== undefined) this.cause = cause
  }
}

export class NetworkError extends Error {
  public cause?: unknown
  constructor(message = 'Network error occurred', cause?: unknown) {
    super(message)
    this.name = 'NetworkError'
    if (cause !== undefined) this.cause = cause
  }
}

export class ResponseError extends Error {
  public response: Response
  public cause?: unknown
  constructor(response: Response, message = 'Response error', cause?: unknown) {
    super(message)
    this.name = 'ResponseError'
    this.response = response
    if (cause !== undefined) this.cause = cause
  }
}
