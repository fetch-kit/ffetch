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
import { hedgePlugin } from '@fetchkit/ffetch/plugins/hedge'
import { requestShortcutsPlugin } from '@fetchkit/ffetch/plugins/request-shortcuts'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'
import { downloadProgressPlugin } from '@fetchkit/ffetch/plugins/download-progress'
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

#### Hedge Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { hedgePlugin } from '@fetchkit/ffetch/plugins/hedge'

const client = createClient({
  plugins: [
    hedgePlugin({
      delay: 50, // 50ms before sending hedge attempt
      maxHedges: 1, // send at most 1 additional attempt
      shouldHedge: (req) => req.method === 'GET', // only hedge GET requests
    }),
  ],
})

// Concurrent requests automatically hedge; fast response wins
const data = await client('https://api.example.com/data')
```

Options:

| Option        | Type                                                       | Default                        | Description                                          |
| ------------- | ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `delay`       | `number \| (req: Request) => number`                       | Required                       | Delay (ms) before sending hedge attempt.             |
| `maxHedges`   | `number`                                                   | `1`                            | Maximum number of hedge attempts.                    |
| `shouldHedge` | `(req: Request) => boolean`                                | Safe methods (GET, HEAD, etc.) | Function to determine if a request should be hedged. |
| `onHedge`     | `(req: Request, attempt: number) => void or Promise<void>` | Undefined                      | Callback when a hedge attempt is sent.               |
| `order`       | `number`                                                   | `15`                           | Plugin execution order.                              |

Notes:

- Hedge races multiple attempts and returns the first _acceptable_ response (ok status, or 4xx except 429). If all attempts settle without a clear winner, the last remaining attempt wins regardless of status.
- 5xx and 429 responses are not winners; hedge will wait for other attempts.
- Loser attempts are cancelled (via `AbortController`) to prevent wasted bandwidth.
- Hedge and retries are _alternative_ strategies; combining them multiplies traffic. Use retries or hedge, not both, unless you carefully quantify the cost.
- Hedge is ordered at `15` (between dedupe at `10` and circuit at `20`). Dedupe collapses callers before hedge races them.

#### Request Shortcuts Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { requestShortcutsPlugin } from '@fetchkit/ffetch/plugins/request-shortcuts'

const client = createClient({
  plugins: [requestShortcutsPlugin()],
})

const users = await client.get('https://api.example.com/users')
const created = await client.post('https://api.example.com/users', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Alice' }),
})
```

Notes:

- The plugin is opt-in; default `createClient()` behavior is unchanged.
- Shortcut methods are available on the client instance: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`.
- Each shortcut is equivalent to `client(url, { ...init, method: 'METHOD' })`.

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

#### Download Progress Plugin

```typescript
import { createClient } from '@fetchkit/ffetch'
import { downloadProgressPlugin } from '@fetchkit/ffetch/plugins/download-progress'

const client = createClient({
  plugins: [
    downloadProgressPlugin((progress, chunk) => {
      console.log(
        `${(progress.percent * 100).toFixed(1)}% — ${progress.transferredBytes} bytes`
      )
    }),
  ],
})

const response = await client('https://example.com/large-file.zip')
await response.arrayBuffer() // drain the stream
```

The `onProgress` callback receives:

- `progress.percent` — fraction from `0` to `1`. Always `0` when `Content-Length` is absent.
- `progress.transferredBytes` — cumulative bytes received so far.
- `progress.totalBytes` — value of `Content-Length` header, or `0` if absent.
- `chunk` — the raw `Uint8Array` chunk just received.

Notes:

- The plugin is opt-in; default `createClient()` behavior is unchanged.
- The response body is fully stream-passthrough — callers can still read `.json()`, `.text()`, `.blob()`, or `.arrayBuffer()` as normal.
- If the response has no body (e.g. `204 No Content`), `onProgress` is never called and the original response is returned unchanged.

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
  // Available when requestShortcutsPlugin() is installed
  get?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  post?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  put?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  patch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  delete?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  head?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  options?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  pendingRequests: PendingRequest[]
  abortAll: () => void
  // Plugin extensions are composed into this type
}
```

When the request shortcuts plugin is installed, the client instance is augmented with HTTP method shortcuts (for example `client.get(url)` and `client.post(url, init)`).

When the response shortcuts plugin is installed, the call return value is augmented with parsing shortcuts while preserving `await client(url)` as `Response`.

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
