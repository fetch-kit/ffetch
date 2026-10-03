import type { Hooks } from './hooks'
import type {
  ClientPlugin,
  PluginExtensionBase,
  PluginRequestPromiseExtensionBase,
} from './plugins'

/**
 * What the retry policy and the retry delay are told about the attempt that just
 * finished. An attempt either fails or produces a response, so exactly one of
 * `error` and `response` describes it - and neither is an error or a response an
 * earlier attempt left behind.
 */
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
  TPlugins extends readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[] = readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[],
> extends CoreClientOptions {
  plugins?: TPlugins
}

export type FFetchRequestOptions = CoreClientOptions

export type FFetchRequestPromise<
  TRequestPromiseExtensions extends object = Record<never, never>,
> = Promise<Response> & TRequestPromiseExtensions

export type FFetch<
  TExtensions extends object = Record<never, never>,
  TRequestPromiseExtensions extends object = Record<never, never>,
> = {
  (
    input: RequestInfo | URL,
    init?: FFetchRequestInit
  ): FFetchRequestPromise<TRequestPromiseExtensions>
  pendingRequests: PendingRequest[]
  abortAll: () => void
} & TExtensions

export interface FFetchRequestInit extends RequestInit, FFetchRequestOptions {}

export type PendingRequest = {
  promise: Promise<Response>
  request: Request
  controller: AbortController
}
