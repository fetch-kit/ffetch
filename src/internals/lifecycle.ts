import { AbortError, TimeoutError } from '../error.js'
import { isCoreError } from './core-error.js'
import type { Hooks } from '../hooks.js'
import type {
  ClientPlugin,
  PluginExtensionBase,
  PluginRequestContext,
  PluginRequestPromiseExtensionBase,
} from '../plugins.js'

type AnyPlugin = ClientPlugin<
  PluginExtensionBase,
  PluginRequestPromiseExtensionBase
>

/**
 * What the lifecycle callbacks have already been told. `onComplete` runs once,
 * whichever way the request settles, and the core reports the error that ended
 * the request at most once - a retry limit reached after a timeout describes
 * the same failure, and the caller hears about it once.
 */
export interface LifecycleState {
  completeCalled: boolean
  coreErrorReported: boolean
}

export function createLifecycleState(): LifecycleState {
  return { completeCalled: false, coreErrorReported: false }
}

/** The outcome of telling every plugin about something. */
export interface HookResult {
  /** Whether any hook failed. */
  failed: boolean
  /** The first failure, which is the one the caller sees. */
  error: unknown
}

/**
 * Reports how the request settled to `onComplete`, exactly once: the pipeline
 * calls this on both paths and only the first call reaches the hook.
 */
export async function callComplete(
  state: LifecycleState,
  hooks: Hooks,
  request: Request,
  response: Response | undefined,
  error: unknown
): Promise<void> {
  if (state.completeCalled) return
  state.completeCalled = true
  await hooks.onComplete?.(request, response, error)
}

/**
 * Reports an error the core raised for the request itself - a timeout, an
 * abort, a transport failure, retries running out - through `onTimeout`,
 * `onAbort` and `onError`. An error that reports another party's verdict, such
 * as a plugin refusing the request, is not one of these and is left to the
 * plugin that raised it.
 */
export async function reportCoreError(
  state: LifecycleState,
  hooks: Hooks,
  error: unknown,
  request: Request
): Promise<void> {
  if (state.coreErrorReported || !isCoreError(error)) return

  state.coreErrorReported = true
  if (error instanceof TimeoutError) {
    await hooks.onTimeout?.(request)
  } else if (error instanceof AbortError) {
    await hooks.onAbort?.(request)
  }
  await hooks.onError?.(request, error)
}

/** Tells every plugin about the response, in plugin order. */
export async function runOnSuccess(
  plugins: readonly AnyPlugin[],
  context: PluginRequestContext,
  response: Response
): Promise<void> {
  for (const plugin of plugins) {
    await plugin.onSuccess?.(context, response)
  }
}

/**
 * Tells every plugin about the failure. Every plugin hears about it, and the
 * first hook that fails decides what the caller sees: a plugin reports an open
 * circuit by throwing from `onError`, so that error has to win over the failure
 * it replaces.
 */
export async function runOnError(
  plugins: readonly AnyPlugin[],
  context: PluginRequestContext,
  error: unknown
): Promise<HookResult> {
  return collectHookFailures(plugins, (plugin) =>
    plugin.onError?.(context, error)
  )
}

/**
 * Tells every plugin the request is over. A failing cleanup hook is collected
 * rather than thrown, so the pipeline can take the request out of
 * `pendingRequests` first: the caller hears about the failure without the
 * request leaking.
 */
export async function runOnFinally(
  plugins: readonly AnyPlugin[],
  context: PluginRequestContext
): Promise<HookResult> {
  return collectHookFailures(plugins, (plugin) => plugin.onFinally?.(context))
}

/**
 * Runs a hook over every plugin, keeping the first failure. Every plugin is
 * asked, and a later hook cannot replace the first failure as the reason the
 * caller sees.
 */
async function collectHookFailures(
  plugins: readonly AnyPlugin[],
  run: (plugin: AnyPlugin) => void | Promise<void>
): Promise<HookResult> {
  let result: HookResult = { failed: false, error: undefined }
  for (const plugin of plugins) {
    try {
      await run(plugin)
    } catch (error) {
      if (!result.failed) result = { failed: true, error }
    }
  }
  return result
}
