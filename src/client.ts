import type {
  FFetchOptions,
  FFetch,
  FFetchRequestInit,
  PendingRequest,
} from './types.js'
import { defaultDelay } from './retry.js'
import { shouldRetry as defaultShouldRetry } from './should-retry.js'
import type {
  PluginExtensions,
  PluginRequestPromiseExtensions,
  ClientPlugin,
  PluginExtensionBase,
  PluginRequestPromiseExtensionBase,
} from './plugins.js'
import { runRequest, type PipelineRuntime } from './internals/pipeline.js'

/**
 * Creates a `fetch` client. The client owns what outlives a request - the
 * plugins and the requests that are in flight - and hands each call to the
 * pipeline, which owns the request itself.
 */
export function createClient<
  TPlugins extends readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[] = readonly ClientPlugin<
    PluginExtensionBase,
    PluginRequestPromiseExtensionBase
  >[],
>(
  opts: FFetchOptions<TPlugins> = {} as FFetchOptions<TPlugins>
): FFetch<
  PluginExtensions<TPlugins>,
  PluginRequestPromiseExtensions<TPlugins>
> {
  const {
    timeout: clientDefaultTimeout = 5_000,
    retries: clientDefaultRetries = 0,
    retryDelay: clientDefaultRetryDelay = defaultDelay,
    shouldRetry: clientDefaultShouldRetry = defaultShouldRetry,
    hooks: clientDefaultHooks = {},
    fetchHandler,
    plugins: inputPlugins = [] as unknown as TPlugins,
  } = opts

  const extensionDescriptors: PropertyDescriptorMap = Object.create(null)

  const plugins = inputPlugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => {
      const aOrder = a.plugin.order ?? 0
      const bOrder = b.plugin.order ?? 0
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.index - b.index
    })
    .map((entry) => entry.plugin)

  for (const plugin of plugins) {
    plugin.setup?.({
      defineExtension: (key, descriptor) => {
        const propertyKey = key as PropertyKey
        if (propertyKey in extensionDescriptors) {
          throw new Error(
            `Plugin extension collision for property "${String(propertyKey)}"`
          )
        }
        if ('get' in descriptor) {
          extensionDescriptors[propertyKey] = {
            get: descriptor.get,
            enumerable: descriptor.enumerable ?? true,
            configurable: false,
          }
          return
        }
        extensionDescriptors[propertyKey] = {
          value: descriptor.value,
          writable: false,
          enumerable: descriptor.enumerable ?? true,
          configurable: false,
        }
      },
    })
  }

  const pendingRequests: PendingRequest[] = []

  // Helper to abort all pending requests
  function abortAll() {
    for (const entry of pendingRequests) {
      entry.controller?.abort()
    }
  }

  // What the pipeline needs from the client: the plugins, the defaults a
  // request starts from, and the registry it registers into.
  const runtime: PipelineRuntime = {
    plugins,
    defaults: {
      timeout: clientDefaultTimeout,
      retries: clientDefaultRetries,
      retryDelay: clientDefaultRetryDelay,
      shouldRetry: clientDefaultShouldRetry,
      hooks: clientDefaultHooks,
    },
    pendingRequests,
    fetchHandler,
    throwOnHttpError: opts.throwOnHttpError ?? false,
  }

  const client = (input: RequestInfo | URL, init: FFetchRequestInit = {}) => {
    let promise = runRequest(runtime, input, init)
    // A plugin can add to what the call returns - a `.json()` shortcut, for
    // example - so each one decorates the promise the caller sees.
    for (const plugin of plugins) {
      if (plugin.decoratePromise) {
        promise = plugin.decoratePromise(promise)
      }
    }
    return promise as Promise<Response> &
      PluginRequestPromiseExtensions<TPlugins>
  }

  Object.defineProperty(client, 'pendingRequests', {
    get() {
      return pendingRequests
    },
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(client, 'abortAll', {
    value: abortAll,
    writable: false,
    enumerable: false,
    configurable: false,
  })

  Object.defineProperties(client, extensionDescriptors)

  return client as FFetch<
    PluginExtensions<TPlugins>,
    PluginRequestPromiseExtensions<TPlugins>
  >
}
