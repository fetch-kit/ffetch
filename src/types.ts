import type { Hooks } from './hooks'

export interface FFetchOptions {
  timeout?: number
  retries?: number
  retryDelay?: number | ((attempt: number) => number)
  shouldRetry?: (err: unknown, res?: Response) => boolean
  circuit?: { threshold: number; reset: number }
  hooks?: Hooks
}

export type FFetch = (
  input: RequestInfo | URL,
  init?: FFetchRequestInit
) => Promise<Response>

export interface FFetchRequestInit extends RequestInit, FFetchOptions {}
