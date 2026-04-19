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

## Configuration

```typescript
type ContextIdPluginOptions = {
  generate?: () => string
  inject?: (id: string, request: Request) => void
  order?: number
}
```

### `generate`

Custom ID generator for each logical request.

### `inject`

Custom injection strategy. Use this if your system expects a different header name or query parameter.

### `order`

Plugin order in the pipeline. Default is `1` so context IDs are available before resilience plugins.

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
