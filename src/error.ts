// Base error class to reduce duplication
class BaseError extends Error {
  public cause?: unknown
  constructor(name: string, message: string, cause?: unknown) {
    super(message)
    this.name = name
    if (cause !== undefined) this.cause = cause
  }
}

export class TimeoutError extends BaseError {
  constructor(message = 'Request timed out', cause?: unknown) {
    super('TimeoutError', message, cause)
  }
}

export class CircuitOpenError extends BaseError {
  constructor(message = 'Circuit is open', cause?: unknown) {
    super('CircuitOpenError', message, cause)
  }
}

export class AbortError extends BaseError {
  constructor(message = 'Request was aborted', cause?: unknown) {
    super('AbortError', message, cause)
  }
}

export class RetryLimitError extends BaseError {
  constructor(message = 'Retry limit reached', cause?: unknown) {
    super('RetryLimitError', message, cause)
  }
}

export class NetworkError extends BaseError {
  constructor(message = 'Network error occurred', cause?: unknown) {
    super('NetworkError', message, cause)
  }
}

export class HttpError extends BaseError {
  constructor(message = 'HTTP error occurred', cause?: unknown) {
    super('HttpError', message, cause)
  }
}
