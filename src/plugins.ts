// Plugin lifecycle contracts for control-flow features.
// These are part of the public API for first-party and third-party plugins.
export type PluginState = Record<string, unknown>
export type PluginExtensionBase = Record<PropertyKey, unknown>

type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => void : never
) extends (arg: infer I) => void
  ? I
  : never

export type PluginExtensionOf<P> =
  P extends ClientPlugin<infer TExtension> ? TExtension : Record<never, never>

export type PluginExtensions<
  TPlugins extends readonly ClientPlugin<PluginExtensionBase>[],
> = Extract<UnionToIntersection<PluginExtensionOf<TPlugins[number]>>, object>

export type PluginSetupContext<
  TExtension extends PluginExtensionBase = Record<never, never>,
> = {
  defineExtension: <K extends keyof TExtension>(
    key: K,
    descriptor:
      | { value: TExtension[K]; enumerable?: boolean }
      | { get: () => TExtension[K]; enumerable?: boolean }
  ) => void
}

export type PluginSignalMetadata = {
  user?: AbortSignal
  transformed?: AbortSignal
  timeout?: AbortSignal
  combined?: AbortSignal
}

export type PluginRetryMetadata = {
  configuredRetries: number
  configuredDelay:
    | number
    | ((ctx: {
        attempt: number
        request: Request
        response?: Response
        error?: unknown
      }) => number)
  attempt: number
  shouldRetryResult?: boolean
  lastError?: unknown
  lastResponse?: Response
}

export type PluginRequestMetadata = {
  startedAt: number
  timeoutMs: number
  signals: PluginSignalMetadata
  retry: PluginRetryMetadata
}

export type PluginRequestContext = {
  request: Request
  init: RequestInit
  state: PluginState
  metadata: PluginRequestMetadata
}

export type PluginDispatch = (ctx: PluginRequestContext) => Promise<Response>

export type ClientPlugin<
  TExtension extends PluginExtensionBase = Record<never, never>,
> = {
  name: string
  order?: number
  setup?: (ctx: PluginSetupContext<TExtension>) => void
  preRequest?: (ctx: PluginRequestContext) => void | Promise<void>
  wrapDispatch?: (next: PluginDispatch) => PluginDispatch
  onSuccess?: (
    ctx: PluginRequestContext,
    response: Response
  ) => void | Promise<void>
  onError?: (ctx: PluginRequestContext, error: unknown) => void | Promise<void>
  onFinally?: (ctx: PluginRequestContext) => void | Promise<void>
}
