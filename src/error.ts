// Custom error classes

export class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit is open') {
    super(message)
    this.name = 'CircuitOpenError'
  }
}

export class AbortError extends Error {
  constructor(message = 'Request was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

export class RetryLimitError extends Error {
  constructor(message = 'Retry limit reached') {
    super(message)
    this.name = 'RetryLimitError'
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network error occurred') {
    super(message)
    this.name = 'NetworkError'
  }
}

export class ResponseError extends Error {
  public response: Response
  constructor(response: Response, message = 'Response error') {
    super(message)
    this.name = 'ResponseError'
    this.response = response
  }
}
