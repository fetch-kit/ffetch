# Plugin Architecture

From version 5 ffetch uses a plugin pipeline for optional behavior such as deduplication and circuit breaking.

## Why Plugins

- Keep the core client small.
- Make optional features tree-shakeable.
- Support first-party and third-party extensions.

## Lifecycle Overview

Plugins can hook into request execution at multiple phases:

1. `setup` (once, at client creation): register client extensions.
2. `preRequest` (per request, before dispatch): validate or prepare request context.
3. `wrapDispatch` (per request): wrap the network dispatch function.
4. `onSuccess` (per request): run after successful completion.
5. `onError` (per request): run after failure.
6. `onFinally` (per request): always run when request settles.

## Plugin Order

Execution order is deterministic:

- Plugins are sorted by `order` (ascending).
- For equal `order`, registration order is preserved.

## Built-in Feature Plugins

```typescript
import { createClient } from '@fetchkit/ffetch'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'

const client = createClient({
  plugins: [
    dedupePlugin({ ttl: 30_000, sweepInterval: 5_000 }),
    circuitPlugin({ threshold: 5, reset: 30_000 }),
  ],
})
```

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

## Registering and Using Custom Plugins

```typescript
import { createClient } from '@fetchkit/ffetch'

const client = createClient({
  timeout: 10_000,
  retries: 2,
  plugins: [
    // custom plugin instances
  ],
})
```

## Best Practices

- Keep plugins side-effect free outside controlled state.
- Prefer per-request data in `ctx.state` instead of global mutable variables.
- Use `order` only when needed; document ordering assumptions.
- Avoid throwing from `onFinally` unless intentional.
- Use `as const` plugin tuples for best TypeScript extension inference.
