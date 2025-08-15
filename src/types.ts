import type { Hooks } from './hooks'

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
  circuit?: { threshold: number; reset: number }
  hooks?: Hooks
}

export type FFetch = (
  input: RequestInfo | URL,
  init?: FFetchRequestInit
) => Promise<Response>

export interface FFetchRequestInit extends RequestInit, FFetchOptions {}
