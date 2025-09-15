# API Reference

## createClient(options?)

Creates a new HTTP client instance with the specified configuration. You can use ffetch as a drop-in replacement for native fetch, or wrap any fetch-compatible implementation (e.g., node-fetch, undici, SvelteKit/Next.js/Nuxt-provided fetch) for SSR, edge, and custom environments.

```typescript
import createClient from '@gkoos/ffetch'

const client = createClient({
  timeout: 5000,
  retries: 3,
  // ... other options
})
```

### Configuration Options

| Option         | Type                                                                                                                      | Default                             | Description                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`      | `number` (ms)                                                                                                             | `5000`                              | Whole-request timeout in milliseconds. Use `0` to disable timeout                                                                               |
| `retries`      | `number`                                                                                                                  | `0`                                 | Maximum retry attempts                                                                                                                          |
| `retryDelay`   | `number \| (ctx: { attempt, request, response, error }) => number`                                                        | Exponential backoff + jitter        | Delay between retries                                                                                                                           |
| `shouldRetry`  | `(ctx: { attempt, request, response, error }) => boolean`                                                                 | Retries on network errors, 5xx, 429 | Custom retry logic                                                                                                                              |
| `circuit`      | `{ threshold: number, reset: number }`                                                                                    | `undefined`                         | Circuit-breaker configuration                                                                                                                   |
| `hooks`        | `{ before, after, onError, onRetry, onTimeout, onAbort, onCircuitOpen, onComplete, transformRequest, transformResponse }` | `{}`                                | Lifecycle hooks and transformers                                                                                                                |
| `fetchHandler` | `(input: RequestInfo \| URL, init?: RequestInit) => Promise<Response>`                                                    | `global fetch`                      | Custom fetch-compatible implementation to wrap (e.g., SvelteKit, Next.js, Nuxt, node-fetch, undici, or any polyfill). Defaults to global fetch. |

### Return Type

```typescript
type FFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & {
    // Per-request overrides for any client option
    timeout?: number
    retries?: number
    retryDelay?: number | ((ctx: RetryContext) => number)
    shouldRetry?: (ctx: RetryContext) => boolean
    circuit?: { threshold: number; reset: number }
    hooks?: HooksConfig
    fetchHandler?: (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response>
  }
) => Promise<Response>
```

The returned function also has a `pendingRequests` property:

```typescript
client.pendingRequests: PendingRequest[]
```

Where `PendingRequest` is:

```typescript
interface PendingRequest {
  promise: Promise<Response>
  request: Request
  controller: AbortController
}
```

The client also exposes an `abortAll()` helper:

```typescript
client.abortAll(): void // Aborts all currently pending requests
```

### Default Values

| Option        | Default Value / Logic                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `timeout`     | `5000` ms (5 seconds)                                                                            |
| `retries`     | `0` (no retries)                                                                                 |
| `retryDelay`  | Exponential backoff + jitter: `({ attempt }) => 2 ** attempt * 200 + Math.random() * 100`        |
| `shouldRetry` | Retries on network errors, HTTP 5xx, or 429. Does not retry on 4xx (except 429) or abort/timeout |
| `circuit`     | `undefined` (circuit breaker disabled by default)                                                |
| `hooks`       | `{}` (no hooks by default)                                                                       |

### Notes

- Signal combination (user, timeout, transformRequest) requires `AbortSignal.any`. If your environment does not support it, you must install a polyfill before using ffetch.
- The first retry attempt uses `attempt = 2` (i.e., the first call is attempt 1, first retry is 2)
- `shouldRetry` default logic: retries on network errors, HTTP 5xx, or 429; does not retry on 4xx (except 429), abort, or timeout errors
- All client options can be overridden on a per-request basis via the `init` parameter

### Type Definitions

```typescript
interface RetryContext {
  attempt: number
  request: Request
  response?: Response
  error?: unknown
}

interface HooksConfig {
  before?: (req: Request) => Promise<void> | void
  after?: (req: Request, res: Response) => Promise<void> | void
  onError?: (req: Request, err: unknown) => Promise<void> | void
  onRetry?: (
    req: Request,
    attempt: number,
    err?: unknown,
    res?: Response
  ) => Promise<void> | void
  onTimeout?: (req: Request) => Promise<void> | void
  onAbort?: (req: Request) => Promise<void> | void
  onCircuitOpen?: (req: Request) => Promise<void> | void
  onComplete?: (
    req: Request,
    res?: Response,
    err?: unknown
  ) => Promise<void> | void
  transformRequest?: (req: Request) => Promise<Request> | Request
  transformResponse?: (
    res: Response,
    req: Request
  ) => Promise<Response> | Response
}
```

### Usage Examples

```typescript
import createClient from '@gkoos/ffetch'

// Basic usage
const client = createClient({
  timeout: 5000,
  retries: 3,
})

// Pass a custom fetch-compatible implementation (SSR, metaframeworks, polyfills, node-fetch, undici, etc.)
const client = createClient({
  timeout: 5000,
  retries: 3,
  fetchHandler: fetch, // SvelteKit/Next.js/Nuxt provide their own fetch
})

// Or use node-fetch/undici in Node.js
import nodeFetch from 'node-fetch'
const clientNode = createClient({ fetchHandler: nodeFetch })
```
