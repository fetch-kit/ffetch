// The node builtins below need `@types/node`. The repo tsconfig sets
// `types: ["vitest"]` and excludes test files, so the language server needs an
// explicit reference to type-check this file.
/// <reference types="node" />

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import type { PluginRequestContext } from '../../src/plugins.js'

// These assertions run against the built package rather than `src`, because
// the identity of the error classes only diverges once each entrypoint is
// bundled on its own. `npm run test:ci` builds `dist/` before running the
// suite; `npm run build` has to run first when invoking Vitest directly.
const require = createRequire(import.meta.url)

function builtUrl(relativePath: string): string {
  return new URL(relativePath, import.meta.url).href
}

function requireBuilt<T>(relativePath: string): T {
  return require(fileURLToPath(builtUrl(relativePath))) as T
}

async function importBuilt<T>(relativePath: string): Promise<T> {
  // `@vite-ignore` keeps the artifact out of Vite's module graph so the
  // assertion loads the exact file the package publishes.
  return (await import(/* @vite-ignore */ builtUrl(relativePath))) as T
}

type ErrorConstructors = {
  CircuitOpenError: new () => Error
  BulkheadFullError: new () => Error
}

type CircuitPluginModule = {
  circuitPlugin: (options: { threshold: number; reset: number }) => {
    onError?: (
      ctx: PluginRequestContext,
      error: unknown
    ) => void | Promise<void>
  }
}

type BulkheadPluginModule = {
  bulkheadPlugin: (options: { maxConcurrent: number; maxQueue?: number }) => {
    wrapDispatch?: (
      next: (ctx: PluginRequestContext) => Promise<Response>
    ) => (ctx: PluginRequestContext) => Promise<Response>
  }
}

function pluginContext(url: string): PluginRequestContext {
  return {
    request: new Request(url),
    init: {},
    state: Object.create(null),
    metadata: {
      startedAt: Date.now(),
      timeoutMs: 0,
      signals: {},
      retry: { configuredRetries: 0, configuredDelay: 0, attempt: 0 },
    },
  }
}

async function capture(settled: Promise<unknown>): Promise<unknown> {
  try {
    await settled
  } catch (error) {
    return error
  }
  return undefined
}

// A single observed failure opens the circuit, and the opener is reported as a
// `CircuitOpenError` constructed by the plugin bundle.
function openCircuit(circuit: CircuitPluginModule): Promise<unknown> {
  const plugin = circuit.circuitPlugin({ threshold: 1, reset: 60_000 })
  const ctx = pluginContext('https://example.com/circuit')
  return capture(Promise.resolve(plugin.onError?.(ctx, new Error('boom'))))
}

// The first dispatch occupies the only slot and never settles, so the second
// is rejected with a `BulkheadFullError` constructed by the plugin bundle.
function fillBulkhead(bulkhead: BulkheadPluginModule): Promise<unknown> {
  const plugin = bulkhead.bulkheadPlugin({ maxConcurrent: 1, maxQueue: 0 })
  const dispatch = plugin.wrapDispatch?.(() => new Promise<Response>(() => {}))
  if (!dispatch) return Promise.resolve(undefined)
  void dispatch(pluginContext('https://example.com/bulkhead-active'))
  return capture(dispatch(pluginContext('https://example.com/bulkhead-full')))
}

beforeAll(() => {
  if (!existsSync(fileURLToPath(builtUrl('../../dist/index.cjs')))) {
    throw new Error(
      'Packaged output missing. Run `npm run build` first, or run the suite through `npm run test:ci`, which builds it.'
    )
  }
})

describe('packaged error identity', () => {
  it('shares CircuitOpenError and BulkheadFullError with the CommonJS root', async () => {
    const root = requireBuilt<ErrorConstructors>('../../dist/index.cjs')
    const circuit = requireBuilt<CircuitPluginModule>(
      '../../dist/plugins/circuit.cjs'
    )
    const bulkhead = requireBuilt<BulkheadPluginModule>(
      '../../dist/plugins/bulkhead.cjs'
    )

    expect(await openCircuit(circuit)).toBeInstanceOf(root.CircuitOpenError)
    expect(await fillBulkhead(bulkhead)).toBeInstanceOf(root.BulkheadFullError)
  })

  it('shares CircuitOpenError and BulkheadFullError with the ESM root', async () => {
    const root = await importBuilt<ErrorConstructors>('../../dist/index.js')
    const circuit = await importBuilt<CircuitPluginModule>(
      '../../dist/plugins/circuit.js'
    )
    const bulkhead = await importBuilt<BulkheadPluginModule>(
      '../../dist/plugins/bulkhead.js'
    )

    expect(await openCircuit(circuit)).toBeInstanceOf(root.CircuitOpenError)
    expect(await fillBulkhead(bulkhead)).toBeInstanceOf(root.BulkheadFullError)
  })
})
