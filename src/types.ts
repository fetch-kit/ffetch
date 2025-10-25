import type { Hooks } from './hooks'
import type { DedupeHashParams } from './dedupeRequestHash'

export interface RetryContext {
  attempt: number
  request: Request
  response?: Response
  error?: unknown
}

export interface FFetchOptions {
  timeout?: number
  retries?: number
  retryDelay?: number | ((ctx: RetryContext) => number)
  shouldRetry?: (ctx: RetryContext) => boolean
  throwOnHttpError?: boolean
  circuit?: { threshold: number; reset: number }
  hooks?: Hooks
  fetchHandler?: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>
  dedupe?: boolean
  dedupeHashFn?: (params: DedupeHashParams) => string | undefined
}

export type FFetch = {
  (input: RequestInfo | URL, init?: FFetchRequestInit): Promise<Response>
  pendingRequests: PendingRequest[]
  abortAll: () => void
  // True if the circuit breaker is open (blocking requests), false otherwise
  circuitOpen: boolean
}

export interface FFetchRequestInit extends RequestInit, FFetchOptions {}

export type PendingRequest = {
  promise: Promise<Response>
  request: Request
  controller?: AbortController
}
