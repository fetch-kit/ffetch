import type { Hooks } from './hooks'
import type { ClientPlugin, PluginExtensionBase } from './plugins'

export interface RetryContext {
  attempt: number
  request: Request
  response?: Response
  error?: unknown
}

export interface CoreClientOptions {
  timeout?: number
  retries?: number
  retryDelay?: number | ((ctx: RetryContext) => number)
  shouldRetry?: (ctx: RetryContext) => boolean
  throwOnHttpError?: boolean
  hooks?: Hooks
  fetchHandler?: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>
}

export interface FFetchOptions<
  TPlugins extends
    readonly ClientPlugin<PluginExtensionBase>[] = readonly ClientPlugin<PluginExtensionBase>[],
> extends CoreClientOptions {
  plugins?: TPlugins
}

export type FFetchRequestOptions = CoreClientOptions

export type FFetch<TExtensions extends object = Record<never, never>> = {
  (input: RequestInfo | URL, init?: FFetchRequestInit): Promise<Response>
  pendingRequests: PendingRequest[]
  abortAll: () => void
} & TExtensions

export interface FFetchRequestInit extends RequestInit, FFetchRequestOptions {}

export type PendingRequest = {
  promise: Promise<Response>
  request: Request
  controller?: AbortController
}
