# Plugin Architecture

From version 5 ffetch uses a plugin pipeline for optional behavior such as deduplication and circuit breaking.

## Why Plugins

- Keep the core client small.
- Make optional features tree-shakeable.
- Support first-party and third-party extensions.

## Lifecycle Overview

Plugins run in a deterministic pipeline with two phases:

1. **Client creation phase**

- `setup`: runs once when `createClient()` is called. Use it to define client extensions.

2. **Request phase (runs for every request)**

- `preRequest`: runs before dispatch. Use it to validate, prepare, or fail fast.
- `wrapDispatch`: wraps request execution (`before` / `after` around `next(ctx)`).
- `decoratePromise`: runs when the request promise is created, before it is returned to the caller.
- `onSuccess` / `onError`: runs when the request settles.
- `onFinally`: always runs after success or error.

### Per-request Timeline

For one request, the flow is:

1. Build request context.
2. Run `preRequest` hooks.
3. Run composed `wrapDispatch` chain.
4. Create the request promise and pass it through `decoratePromise`.
5. Return the (possibly decorated) promise to the caller.
6. Later, when it settles, run `onSuccess` **or** `onError`.
7. Run `onFinally`.

### What Each Hook Is For

- `preRequest`: prepare request context (auth, validation, early abort).
- `wrapDispatch`: control execution around the network call.
- `decoratePromise`: improve caller ergonomics (for example, add `.json()`).
- `onSuccess` / `onError`: record outcomes, metrics, and side effects.
- `onFinally`: cleanup that must always happen.

## Plugin Order

Execution order is deterministic:

- Plugins are sorted by `order` (ascending).
- For equal `order`, registration order is preserved.

Order details per hook:

- `preRequest`, `onSuccess`, `onError`, `onFinally`, `decoratePromise`: run in sorted order.
- `wrapDispatch`: composed in reverse to create nested wrappers. In practice, lower `order` wraps outermost (`before` runs first, `after` runs last).

## Built-in Feature Plugins

The sections below are grouped by learning priority (convenience first, resilience second), not by runtime execution order. For execution order semantics, see [Plugin Order](#plugin-order).

| Category    | Plugins                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| Convenience | `requestShortcutsPlugin`, `responseShortcutsPlugin`, `downloadProgressPlugin` |
| Resilience  | `dedupePlugin`, `circuitPlugin`, `bulkheadPlugin`, `hedgePlugin`              |

```typescript
import { createClient } from '@fetchkit/ffetch'
import { requestShortcutsPlugin } from '@fetchkit/ffetch/plugins/request-shortcuts'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'
import { downloadProgressPlugin } from '@fetchkit/ffetch/plugins/download-progress'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'
import { bulkheadPlugin } from '@fetchkit/ffetch/plugins/bulkhead'
import { hedgePlugin } from '@fetchkit/ffetch/plugins/hedge'

const client = createClient({
  plugins: [
    requestShortcutsPlugin(),
    responseShortcutsPlugin(),
    downloadProgressPlugin((progress) => {
      console.log(`${(progress.percent * 100).toFixed(1)}%`)
    }),
    dedupePlugin({ ttl: 30_000, sweepInterval: 5_000 }),
    circuitPlugin({ threshold: 5, reset: 30_000 }),
    bulkheadPlugin({ maxConcurrent: 10, maxQueue: 50 }),
    hedgePlugin({ delay: 50 }),
  ],
})
```

### Convenience plugins

The request shortcuts plugin adds HTTP method shortcuts on the client instance:

```typescript
const client = createClient({
  plugins: [requestShortcutsPlugin()],
})

const usersResponse = await client.get('https://example.com/users')
const createResponse = await client.post('https://example.com/users', {
  body: JSON.stringify({ name: 'Alice' }),
  headers: { 'content-type': 'application/json' },
})
```

The response shortcuts plugin adds parsing convenience methods on the returned request promise:

```typescript
const client = createClient({
  plugins: [responseShortcutsPlugin()],
})

const data = await client('https://example.com/users').json()
```

The download progress plugin exposes chunk-level progress updates:

```typescript
const client = createClient({
  plugins: [
    downloadProgressPlugin((progress) => {
      console.log(progress.transferredBytes, progress.percent)
    }),
  ],
})
```

### Resilience plugins

The dedupe plugin collapses identical in-flight requests:

```typescript
const client = createClient({
  plugins: [dedupePlugin({ ttl: 30_000, sweepInterval: 5_000 })],
})
```

The circuit plugin fails fast after repeated failures:

```typescript
const client = createClient({
  plugins: [circuitPlugin({ threshold: 5, reset: 30_000 })],
})
```

The bulkhead plugin limits per-client concurrency and applies backpressure with a bounded queue:

```typescript
const client = createClient({
  plugins: [bulkheadPlugin({ maxConcurrent: 10, maxQueue: 50 })],
})

const response = await client('https://example.com/data')
```

> **Warning:** Bulkhead and retries can amplify queue pressure, because each retry attempt must reacquire a bulkhead slot. Keep retry counts conservative when using small bulkhead limits.

The hedge plugin races multiple concurrent attempts and cancels losers when the first acceptable response wins:

```typescript
const client = createClient({
  plugins: [hedgePlugin({ delay: 50 })],
})

// Hedge reduces tail latency by racing attempts after a short delay
const response = await client('https://example.com/data')
```

> **Warning:** Combining `hedgePlugin` with retries multiplies upstream traffic. Each retry attempt can itself spawn `1 + maxHedges` requests. For example, `retries: 2` with `maxHedges: 1` can produce up to 6 requests for a single call. Prefer one or the other — hedging for tail latency, retries for transient failures — rather than combining both.

Built-in and custom plugins are configured the same way: pass plugin instances in the `plugins` array when calling `createClient()`.

## From Using to Building Plugins

Once you're comfortable composing built-in plugins, the sections below show how to author your own plugins and extensions.

## Writing a Custom Plugin

Use the public `ClientPlugin` type.

```typescript
import { createClient, type ClientPlugin } from '@fetchkit/ffetch'

type TimingExtension = {
  lastDurationMs: number
}

function timingPlugin(): ClientPlugin<TimingExtension> {
  let lastDurationMs = 0

  return {
    name: 'timing',
    order: 100,
    setup: ({ defineExtension }) => {
      defineExtension('lastDurationMs', {
        get: () => lastDurationMs,
      })
    },
    preRequest: (ctx) => {
      ctx.state.start = Date.now()
    },
    onFinally: (ctx) => {
      const start =
        typeof ctx.state.start === 'number' ? ctx.state.start : Date.now()
      lastDurationMs = Date.now() - start
    },
  }
}

const client = createClient({
  plugins: [timingPlugin()] as const,
})

await client('https://example.com/data')
console.log(client.lastDurationMs)
```

## Plugin Context and Types

For advanced plugins, import public context types:

```typescript
import type {
  ClientPlugin,
  PluginRequestContext,
  PluginDispatch,
  PluginSetupContext,
} from '@fetchkit/ffetch'
```

What you can access in request context:

- `ctx.request`: current `Request` object.
- `ctx.init`: request init/options.
- `ctx.state`: per-request mutable plugin state.
- `ctx.metadata`: signal and retry metadata.

## Wrapping Dispatch

Use `wrapDispatch` when you need around-advice behavior (before/after dispatch in one place):

```typescript
import type { ClientPlugin } from '@fetchkit/ffetch'

const tracingPlugin: ClientPlugin = {
  name: 'tracing',
  wrapDispatch: (next) => async (ctx) => {
    console.log('start', ctx.request.url)
    try {
      const response = await next(ctx)
      console.log('end', response.status)
      return response
    } catch (error) {
      console.log('error', error)
      throw error
    }
  },
}
```

## Decorating the Returned Promise

Use `decoratePromise` to attach convenience behavior to the returned promise without replacing native `Response` behavior.

```typescript
import type { ClientPlugin } from '@fetchkit/ffetch'

const jsonShortcutPlugin: ClientPlugin<
  Record<never, never>,
  { json: () => Promise<unknown> }
> = {
  name: 'json-shortcut',
  decoratePromise: (promise) => {
    Object.defineProperty(promise, 'json', {
      value: function json(this: Promise<Response>) {
        return this.then((response) => response.json())
      },
      enumerable: false,
      writable: false,
      configurable: false,
    })
    return promise as Promise<Response> & { json: () => Promise<unknown> }
  },
}
```

## Best Practices

- Keep plugins side-effect free outside controlled state.
- Prefer per-request data in `ctx.state` instead of global mutable variables.
- Use `order` only when needed; document ordering assumptions.
- Avoid throwing from `onFinally` unless intentional.
- Use `as const` plugin tuples for best TypeScript extension inference.

## App-Level Concerns

Plugins provide request-time mechanics, but some resilience concerns are best handled at application boundaries:
For a deployment checklist, metrics baseline, and incident playbook, see [production-operations.md](./production-operations.md).

- **Graceful circuit recovery**: When a circuit closes, avoid sending all queued or waiting traffic at once. Recover gradually (for example, ramp request rate or release waiting callers in batches) to prevent thundering herd spikes.
- **Bulkhead boundaries**: Decide bulkhead scope per dependency (service, host, or endpoint class). A single global bulkhead can cause unrelated traffic to compete for the same slots.
- **Retry and hedge budgets**: Set retry/hedge limits based on upstream capacity. Multiplicative traffic (`retries` x hedges) can overwhelm dependencies even if each plugin is correct in isolation.
- **Caching strategy**: Pair plugin behavior with explicit cache policy (TTL, stale-while-revalidate, cache keys). Good caching reduces load and tail latency, but stale or over-broad keys can hide failures or serve incorrect data.
- **Fallback behavior**: Define app-level fallback responses or degraded modes when circuit/bulkhead limits are hit, instead of only surfacing raw errors to end users.
- **Observability and alerting**: Emit metrics for circuit opens/closes, bulkhead queue depth, and rejection rates. These signals are critical for tuning thresholds and queue sizes.
