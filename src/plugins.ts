// Plugin lifecycle contracts for control-flow features.
// These are part of the public API for first-party and third-party plugins.
export type PluginState = Record<string, unknown>
export type PluginExtensionBase = Record<PropertyKey, unknown>
export type PluginRequestPromiseExtensionBase = Record<PropertyKey, unknown>

type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => void : never
) extends (arg: infer I) => void
  ? I
  : never

export type PluginExtensionOf<P> =
  P extends ClientPlugin<infer TExtension> ? TExtension : Record<never, never>

export type PluginRequestPromiseExtensionOf<P> =
  P extends ClientPlugin<PluginExtensionBase, infer TRequestPromiseExtension>
    ? TRequestPromiseExtension
    : Record<never, never>

// `UnionToIntersection<never>` is `unknown`, and `Extract<unknown, object>` is
// `never`, so a plugin list that is empty at the type level - `never[]` from
// `[]`, `readonly []` from `[] as const` - used to erase every extension the
// client is composed from, leaving a client that is itself `never`. An empty
// extension union contributes an empty object instead.
type PluginExtensionsFrom<TExtension> = [TExtension] extends [never]
  ? Record<never, never>
  : Extract<UnionToIntersection<TExtension>, object>

export type PluginExtensions<
  TPlugins extends readonly ClientPlugin<PluginExtensionBase>[],
> = PluginExtensionsFrom<PluginExtensionOf<TPlugins[number]>>

export type PluginRequestPromiseExtensions<
  TPlugins extends readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[],
> = PluginExtensionsFrom<PluginRequestPromiseExtensionOf<TPlugins[number]>>

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

/**
 * Who raised the error the lifecycle hooks are being told about. `attempt`
 * means the request's own attempt raised it, so it is evidence about the
 * dependency. `hook` means local code did - a plugin refusing the request, a
 * retry policy that threw, a response hook that failed - so it is not.
 */
export type PluginProvenance = 'attempt' | 'hook'

export type PluginRequestMetadata = {
  startedAt: number
  timeoutMs: number
  signals: PluginSignalMetadata
  retry: PluginRetryMetadata
  /**
   * Who raised the error `onError` is being told about, kept up to date while
   * the request runs. It is `attempt` only for an error the request's own
   * attempt raised; everything else is `hook`, including a request that has not
   * reached an attempt yet. A context built by hand can leave it out, and any
   * value other than `attempt` has to be read as local code.
   */
  provenance?: PluginProvenance
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
  TRequestPromiseExtension extends PluginRequestPromiseExtensionBase = Record<
    never,
    never
  >,
> = {
  name: string
  order?: number
  setup?: (ctx: PluginSetupContext<TExtension>) => void
  preRequest?: (ctx: PluginRequestContext) => void | Promise<void>
  beforeAttempt?: (
    ctx: PluginRequestContext,
    attempt: number
  ) => void | Promise<void>
  wrapDispatch?: (next: PluginDispatch) => PluginDispatch
  decoratePromise?: (
    promise: Promise<Response>
  ) => Promise<Response> & TRequestPromiseExtension
  onSuccess?: (
    ctx: PluginRequestContext,
    response: Response
  ) => void | Promise<void>
  onError?: (ctx: PluginRequestContext, error: unknown) => void | Promise<void>
  onFinally?: (ctx: PluginRequestContext) => void | Promise<void>
}
