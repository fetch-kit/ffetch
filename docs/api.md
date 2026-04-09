# API Reference

## Imports

`@fetchkit/ffetch` now exports named symbols only.

```typescript
import { createClient } from '@fetchkit/ffetch'
```

Feature plugins are exported from subpath entrypoints:

```typescript
import {
  dedupePlugin,
  dedupeRequestHash,
} from '@fetchkit/ffetch/plugins/dedupe'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'
```

Custom plugin authoring is documented in [plugins.md](./plugins.md).

## createClient(options?)

Creates a new HTTP client instance.

```typescript
import { createClient } from '@fetchkit/ffetch'

const client = createClient({
  timeout: 5000,
  retries: 2,
  throwOnHttpError: true,
})
```

### Core Options

| Option             | Type                                                                                                       | Default                             | Description                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `timeout`          | `number` (ms)                                                                                              | `5000`                              | Whole-request timeout in milliseconds. Use `0` to disable timeout.                    |
| `retries`          | `number`                                                                                                   | `0`                                 | Maximum retry attempts.                                                               |
| `retryDelay`       | `number \| (ctx: { attempt, request, response, error }) => number`                                         | Exponential backoff + jitter        | Delay between retries.                                                                |
| `shouldRetry`      | `(ctx: { attempt, request, response, error }) => boolean`                                                  | Retries on network errors, 5xx, 429 | Custom retry logic.                                                                   |
| `throwOnHttpError` | `boolean`                                                                                                  | `false`                             | If true, throws an `HttpError` for 4xx/5xx/429 after retries are exhausted.           |
| `hooks`            | `{ before, after, onError, onRetry, onTimeout, onAbort, onComplete, transformRequest, transformResponse }` | `{}`                                | Lifecycle hooks and transformers.                                                     |
| `fetchHandler`     | `(input: RequestInfo \| URL, init?: RequestInit) => Promise<Response>`                                     | `global fetch`                      | Custom fetch-compatible implementation to wrap.                                       |
| `plugins`          | `ClientPlugin[]`                                                                                           | `[]`                                | Optional plugin list. Use this for dedupe, circuit breaker, and third-party features. |

### Plugin Features

#### Deduplication Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'

const client = createClient({
  plugins: [
    dedupePlugin({
      hashFn: (params) => `${params.method}|${params.url}|${params.body}`,
      ttl: 30_000,
      sweepInterval: 5_000,
    }),
  ],
})
```

#### Circuit Breaker Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'

const client = createClient({
  plugins: [
    circuitPlugin({
      threshold: 5,
      reset: 30_000,
      onCircuitOpen: (req) => console.warn('Circuit opened:', req.url),
      onCircuitClose: (req) => console.info('Circuit closed:', req.url),
    }),
  ],
})

if (client.circuitOpen) {
  console.warn('Circuit breaker is open')
}
```

#### Response Shortcuts Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'

const client = createClient({
  plugins: [responseShortcutsPlugin()],
})

const data = await client('https://api.example.com/users').json<
  Array<{ id: number; name: string }>
>()
const html = await client('https://example.com/page').text()
```

Notes:

- The plugin is opt-in; default `createClient()` behavior is unchanged.
- `await client(url)` still returns a native `Response`.
- Shortcut methods are available on the returned request promise: `json`, `text`, `blob`, `arrayBuffer`, `formData`.

### Custom Plugins

Use the public plugin types from the root package and register your plugins via `plugins`.

```typescript
import { createClient, type ClientPlugin } from '@fetchkit/ffetch'

const headerPlugin: ClientPlugin = {
  name: 'header-plugin',
  preRequest: (ctx) => {
    ctx.request = new Request(ctx.request, {
      headers: {
        ...Object.fromEntries(ctx.request.headers),
        'x-trace-id': crypto.randomUUID(),
      },
    })
  },
}

const client = createClient({
  plugins: [headerPlugin],
})
```

See [plugins.md](./plugins.md) for full lifecycle, ordering, extensions, and advanced patterns.

### Removed Legacy Options (Breaking)

The following top-level options were removed:

- `dedupe`
- `dedupeHashFn`
- `dedupeTTL`
- `dedupeSweepInterval`
- `circuit`

Use plugin modules instead via `plugins: [...]`.

### Per-request Overrides

Core options can still be overridden per request:

```typescript
await client('https://example.com/data', {
  timeout: 1000,
  retries: 0,
  throwOnHttpError: true,
})
```

### Return Type

```typescript
type FFetch = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  pendingRequests: PendingRequest[]
  abortAll: () => void
  // Plugin extensions are composed into this type
}
```

When the response shortcuts plugin is installed, the call return value is augmented with shortcut methods while preserving `await client(url)` as `Response`.

```typescript
const client = createClient({
  plugins: [responseShortcutsPlugin()] as const,
})

// Promise<Response> + shortcut methods
const data = await client('https://example.com/data').json<{ ok: boolean }>()

// Native behavior still works
const response = await client('https://example.com/data')
```

### Default Values

| Option             | Default Value / Logic                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `timeout`          | `5000` ms                                                                                       |
| `retries`          | `0`                                                                                             |
| `retryDelay`       | `({ attempt }) => 2 ** attempt * 200 + Math.random() * 100`                                     |
| `shouldRetry`      | Retries on network errors, HTTP 5xx, or 429. Does not retry 4xx (except 429), abort, or timeout |
| `throwOnHttpError` | `false`                                                                                         |
| `hooks`            | `{}`                                                                                            |
| `plugins`          | `[]`                                                                                            |

### Notes

- Signal combination (user, timeout, transformRequest) requires `AbortSignal.any`.
- The first retry decision uses `attempt = 1`.
- Plugin order is deterministic: first by `order`, then by registration order.
