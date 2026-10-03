// Type-level contract for the plugin extension surface of `createClient`.
//
// This file is type-checked by `npm run typecheck` (`tsc -p test --noEmit`) and
// is never executed: vitest only collects `*.test.ts`, so keep the
// `.contract.ts` suffix or the call sites below would start issuing requests.
//
// It exists because a runtime test cannot catch a type regression. An empty
// plugin list used to infer `never` for the whole client: `createClient`
// returned an uncallable type while every test kept passing.
import { createClient } from '../../src/index.js'
import { requestShortcutsPlugin } from '../../src/plugins/request-shortcuts.js'
import { responseShortcutsPlugin } from '../../src/plugins/response-shortcuts.js'
import type {
  ClientPlugin,
  PluginExtensions,
  PluginRequestPromiseExtensions,
} from '../../src/plugins.js'
import type { FFetchOptions } from '../../src/types.js'

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T

/** `true` when `A` and `B` are the same type in both directions. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type IsNever<T> = [T] extends [never] ? true : false
type IsNotNever<T> = IsNever<T> extends true ? false : true

// An empty plugin list is spelled `never[]`, `readonly []` or a typed options
// object, and none of them may erase the client or its return value.
const emptyInline = createClient({ plugins: [] })
const emptyReadonly = createClient({ plugins: [] as const })

const emptyTuple = [] as const
const emptyVariable = createClient({ plugins: emptyTuple })

const emptyOptions: FFetchOptions<[]> = { plugins: [] }
const emptyAnnotated = createClient(emptyOptions)

// A plugin without extensions extends the client with nothing, like an empty
// list does.
const noExtension = createClient({ plugins: [{ name: 'noop' }] })

const emptyInlineCall = emptyInline('https://example.com')
const emptyReadonlyCall = emptyReadonly('https://example.com')
const emptyVariableCall = emptyVariable('https://example.com')
const emptyAnnotatedCall = emptyAnnotated('https://example.com')
const noExtensionCall = noExtension('https://example.com')

emptyInline.abortAll()
const emptyPending = emptyInline.pendingRequests

// Installed plugins must keep widening the client and the call result.
const shortcuts = createClient({ plugins: [requestShortcutsPlugin()] })
const shortcutsGet = shortcuts.get('https://example.com')

const decorated = createClient({ plugins: [responseShortcutsPlugin()] })
const decoratedJson = decorated('https://example.com').json<{ ok: boolean }>()

export type PluginExtensionContract = [
  // The extension helpers resolve an empty plugin union to an empty object
  // instead of `never`.
  Assert<Equals<PluginExtensions<[]>, Record<never, never>>>,
  Assert<Equals<PluginExtensions<never[]>, Record<never, never>>>,
  Assert<Equals<PluginExtensions<readonly []>, Record<never, never>>>,
  Assert<Equals<PluginRequestPromiseExtensions<[]>, Record<never, never>>>,
  Assert<Equals<PluginRequestPromiseExtensions<never[]>, Record<never, never>>>,
  // Extensions of installed plugins are still intersected in.
  Assert<
    Equals<
      PluginExtensions<[ClientPlugin<{ hello: string }>]>,
      { hello: string }
    >
  >,
  Assert<IsNotNever<typeof shortcutsGet>>,
  Assert<Equals<typeof decoratedJson, Promise<{ ok: boolean }>>>,
  // A client built from an empty list, and the promise its calls return, must
  // never collapse to `never`.
  Assert<IsNotNever<typeof emptyInline>>,
  Assert<IsNotNever<typeof emptyReadonly>>,
  Assert<IsNotNever<typeof emptyVariable>>,
  Assert<IsNotNever<typeof emptyAnnotated>>,
  Assert<IsNotNever<typeof noExtension>>,
  Assert<IsNotNever<typeof emptyInlineCall>>,
  Assert<IsNotNever<typeof emptyReadonlyCall>>,
  Assert<IsNotNever<typeof emptyVariableCall>>,
  Assert<IsNotNever<typeof emptyAnnotatedCall>>,
  Assert<IsNotNever<typeof noExtensionCall>>,
]

/** Keeps the subjects above referenced as values too, so linting the file for
 *  unused variables stays clean even though every check here is type-level. */
export const pluginExtensionContractSubjects = {
  emptyInline,
  emptyReadonly,
  emptyVariable,
  emptyAnnotated,
  noExtension,
  emptyInlineCall,
  emptyReadonlyCall,
  emptyVariableCall,
  emptyAnnotatedCall,
  noExtensionCall,
  emptyPending,
  shortcutsGet,
  decoratedJson,
} as const
