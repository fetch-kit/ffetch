# Context ID Plugin

The `contextIdPlugin` injects a stable context identifier into every outgoing request and keeps it consistent across retries and hedged attempts.

This helps correlate all physical HTTP attempts that belong to one logical request.

## Install and Use

```typescript
import { createClient } from '@fetchkit/ffetch'
import { contextIdPlugin } from '@fetchkit/ffetch/plugins/context-id'

const client = createClient({
  plugins: [contextIdPlugin()],
})
```

By default, the plugin:

- Generates IDs with `crypto.randomUUID()` (fallback included for older runtimes)
- Injects the ID into the `x-context-id` header
- Emits a W3C `traceparent` header (see [Traceparent Propagation](#traceparent-propagation))

## Configuration

```typescript
type ContextIdPluginOptions = {
  generate?: () => string
  inject?: (id: string, request: Request) => void
  order?: number
  traceparent?: boolean | { enabled?: boolean; flags?: string }
}
```

### `generate`

Custom ID generator for each logical request.

### `inject`

Custom injection strategy. Use this if your system expects a different header name or query parameter.

### `order`

Plugin order in the pipeline. Default is `1` so context IDs are available before resilience plugins.

## Traceparent Propagation

When enabled (the default), the plugin also propagates a [W3C Trace Context](https://www.w3.org/TR/trace-context/) `traceparent` header on every physical attempt.

- **Logical request** → one stable `trace-id` across retries and hedges.
- **Physical attempt** → a fresh `span-id` per attempt.
- Header format: `00-<trace-id>-<span-id>-<trace-flags>`.

If the incoming request already carries a valid `traceparent` header, the plugin reuses its `trace-id` and `trace-flags` and only regenerates the `span-id`. Malformed incoming headers fall back to a generated `trace-id`.

### Options

| Option        | Type                                               | Default | Description                                           |
| ------------- | -------------------------------------------------- | ------- | ----------------------------------------------------- |
| `traceparent` | `boolean \| { enabled?: boolean; flags?: string }` | `true`  | Enables/disables propagation and sets the trace flags |

The default trace flags are `01` (sampled). Set a custom value with `traceparent: { flags: '00' }` or disable propagation entirely with `traceparent: false`.

## Example: Custom Header

```typescript
const client = createClient({
  plugins: [
    contextIdPlugin({
      generate: () => crypto.randomUUID(),
      inject: (id, request) => {
        request.headers.set('x-correlation-id', id)
      },
    }),
  ],
})
```
