![npm](https://img.shields.io/npm/v/@gkoos/ffetch)
![Downloads](https://img.shields.io/npm/dm/@gkoos/ffetch)
![GitHub stars](https://img.shields.io/github/stars/gkoos/ffetch?style=social)
![Build](https://github.com/gkoos/ffetch/actions/workflows/ci.yml/badge.svg)
![codecov](https://codecov.io/gh/gkoos/ffetch/branch/main/graph/badge.svg)
![MIT](https://img.shields.io/npm/l/@gkoos/ffetch)
![bundlephobia](https://badgen.net/bundlephobia/minzip/@gkoos/ffetch)
![Types](https://img.shields.io/npm/types/@gkoos/ffetch)

# @gkoos/ffetch

**A production-ready TypeScript-first drop-in replacement for native fetch.**

- **Timeouts** – per-request or global
- **Retries** – exponential back-off + jitter
- **Circuit breaker** – trip after N failures
- **Hooks** – logging, auth, metrics, request/response transformation
- **Per-request overrides** – customize behavior on a per-request basis
- **Universal** – Node, Browser, Cloudflare Workers, React Native
- **Zero runtime deps** – ships as dual ESM/CJS

## Install

```bash
npm install @gkoos/ffetch
```

### Minified Builds & CDN Usage

For browser/CDN usage, a minified ESM build is available:

- **jsDelivr:** `https://cdn.jsdelivr.net/npm/@gkoos/ffetch/dist/index.min.js`
- **unpkg:** `https://unpkg.com/@gkoos/ffetch/dist/index.min.js`

You can use it directly in a `<script type="module">` tag:

```html
<script type="module">
  import createClient from 'https://unpkg.com/@gkoos/ffetch/dist/index.min.js'
  // ...your code...
</script>
```

Source maps are included for easier debugging in development.

## Quick Start

```typescript
import createClient from '@gkoos/ffetch'

const f = createClient({
  timeout: 5000,
  retries: 3,
  retryDelay: ({ attempt }) => 2 ** attempt * 100 + Math.random() * 100,
})

const res = await f('https://api.example.com/v1/users')
const data = await res.json()
```

---

## API

createClient(options?)

| Option       | Type & default                                                                                                            | Description                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `timeout`    | `number` (ms)                                                                                                             | whole-request timeout                      |
| `retries`    | `number` (0)                                                                                                              | max retry attempts                         |
| `retryDelay` | `number \| (ctx: { attempt, request, response, error }) => number` (exponential backoff + jitter)                         | delay between retries                      |
| `circuit`    | `{ threshold, reset }`                                                                                                    | circuit-breaker rules                      |
| `hooks`      | `{ before, after, onError, onRetry, onTimeout, onAbort, onCircuitOpen, onComplete, transformRequest, transformResponse }` | lifecycle hooks/interceptors, transformers |

Returns a fetch-like function:

```typescript
type FFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>
```

### Defaults

| Option        | Default Value / Logic                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `timeout`     | `5000` ms (5 seconds)                                                                                |
| `retries`     | `0` (no retries)                                                                                     |
| `retryDelay`  | Exponential backoff + jitter: <br>`({ attempt }) => 2 ** attempt * 200 + Math.random() * 100`        |
| `shouldRetry` | Retries on network errors, HTTP 5xx, or 429. <br>Does not retry on 4xx (except 429) or abort/timeout |
| `circuit`     | `undefined` (circuit breaker disabled by default)                                                    |
| `hooks`       | `{}` (no hooks by default)                                                                           |

**Note:**

- The first retry attempt uses `attempt = 2` (i.e., the first call is attempt 1, first retry is 2).
- `shouldRetry` default logic: retries on network errors, HTTP 5xx, or 429; does not retry on 4xx (except 429), abort, or timeout errors.

## Advanced

### Per-request overrides

You can override any client option on a per-request basis by passing it in the `init` parameter:

```typescript
const f = createClient({ timeout: 5000, retries: 2 })

// Override timeout and retries for this request only
await f('https://api.example.com/v1/users', {
  timeout: 1000, // 1s timeout for this request
  retries: 5, // up to 5 retries for this request
})

// Use a custom retry delay function for a single request
await f('https://api.example.com/v1/data', {
  retryDelay: ({ attempt }) => 100 * attempt, // linear backoff for this request
})

// Override hooks for a single request
await f('https://api.example.com/v1/metrics', {
  hooks: {
    before: (req) => console.log('Single request:', req.url),
  },
})
```

### Retry/Backoff and Retry Policy

#### retryDelay

You can provide a function for `retryDelay` that receives a context object:

```typescript
retryDelay: ({ attempt, request, response, error }) => {
  // attempt: number (starts at 2 for first retry)
  // request: Request
  // response: Response | undefined
  // error: unknown
  return 100 * attempt
}
```

#### shouldRetry

You can provide a function for `shouldRetry` that receives the same context object:

```typescript
shouldRetry: ({ attempt, request, response, error }) => {
  // Retry only on 503
  return response?.status === 503
}
```

### Custom Error Types

`ffetch` throws custom error classes for robust error handling. All custom errors have a `.cause` property:

- If the error is mapped from a native error (e.g., a DOMException or TypeError from fetch), `.cause` will reference the original error.
- If the error is user-initiated (e.g., user aborts a request), `.cause` will be `undefined`.

This allows you to inspect the underlying cause for advanced debugging or cross-environment handling.

You can catch and handle these errors as needed:

- `TimeoutError`: The request timed out.
- `AbortError`: The request was aborted by the user.
- `CircuitOpenError`: The circuit breaker is open and requests are blocked.
- `RetryLimitError`: The retry limit was reached and the request failed.
- `NetworkError`: A network error occurred (e.g., DNS failure, offline).
- `ResponseError`: The response was not ok (non-2xx status), if you choose to throw on HTTP errors.

#### Example: Handling Custom Errors

```typescript
import createClient, {
  TimeoutError,
  AbortError,
  CircuitOpenError,
  RetryLimitError,
  NetworkError,
  ResponseError,
} from 'ffetch'

const client = createClient({ timeout: 1000, retries: 2 })

try {
  const res = await client('https://example.com')
  // ...handle response...
} catch (err) {
  if (err instanceof TimeoutError) {
    // handle timeout
  } else if (err instanceof AbortError) {
    // handle user abort
  } else if (err instanceof CircuitOpenError) {
    // handle circuit breaker open
  } else if (err instanceof RetryLimitError) {
    // handle retry limit reached
  } else if (err instanceof NetworkError) {
    // handle network error
  } else if (err instanceof ResponseError) {
    // handle HTTP error
  } else {
    // handle unknown error
  }
}
```

### Circuit breaker

The circuit breaker pattern protects your service from repeated failures by temporarily blocking requests after a threshold of consecutive errors. This helps prevent cascading failures and allows your system to recover gracefully.

**How it works:**

- When the number of consecutive failures reaches the `threshold`, the circuit "opens" and all further requests fail fast with a `CircuitOpenError`.
- After the `reset` period (in milliseconds), the circuit "closes" and requests are allowed again.
- If a request succeeds, the failure count resets.

**Parameters:**

- `threshold`: _(number)_ — How many consecutive failures will "trip" (open) the circuit. Example: `5` means after 5 failures, the circuit opens.
- `reset`: _(number, ms)_ — How long (in milliseconds) to wait before closing the circuit and allowing requests again. Example: `30_000` is 30 seconds.

**Example:**

```typescript
const f = createClient({
  retries: 0, // let breaker handle
  circuit: { threshold: 5, reset: 30_000 },
})
```

### Hooks

You can use hooks to observe, log, or modify the request/response lifecycle. All hooks are optional and can be set globally or per-request.

- `before(request)`: Called before each request is sent.
- `after(request, response)`: Called after a successful response.
- `onError(request, error)`: Called when a request fails with any error.
- `onRetry(request, attempt, error, response)`: Called before each retry attempt.
- `onTimeout(request)`: Called when a request times out.
- `onAbort(request)`: Called when a request is aborted by the user.
- `onCircuitOpen(request)`: Called when the circuit breaker is open and a request is blocked.
- `onComplete(request, response, error)`: Called after every request, whether it succeeded or failed.

```typescript
const f = createClient({
  hooks: {
    before: async (req) => console.log('→', req.url),
    after: async (req, res) => console.log('←', res.status),
    onError: async (req, err) => console.error('Error:', err),
    onRetry: async (req, attempt, err) => console.log('Retrying', attempt),
    onTimeout: async (req) => console.warn('Timeout:', req.url),
    onAbort: async (req) => console.warn('Aborted:', req.url),
    onCircuitOpen: async (req) => console.warn('Circuit open:', req.url),
    onComplete: async (req, res, err) => console.log('Done:', req.url),
  },
})
```

### Request/Response Transformation

You can use the `transformRequest` and `transformResponse` hooks to modify the outgoing request or the incoming response.

```typescript
const f = createClient({
  hooks: {
    transformRequest: async (req) => {
      // Add a custom header
      return new Request(req, {
        headers: { ...Object.fromEntries(req.headers), 'x-api-key': 'secret' },
      })
    },
    transformResponse: async (res, req) => {
      // Automatically parse JSON and attach to the response
      const data = await res.json()
      // You can return a new Response or attach data to the response as needed
      return new Response(JSON.stringify({ data, meta: { url: req.url } }), {
        status: res.status,
        headers: res.headers,
      })
    },
  },
})
```

These hooks allow you to inject authentication, modify request/response bodies, or implement custom parsing and logging logic.

---

## Note on Timeout vs Abort Errors

In most environments, `ffetch` will throw a `TimeoutError` if a request times out, and an `AbortError` if the user aborts the request. However, due to differences in how abort signals are handled in Node.js, browsers, and CI environments, a timeout may sometimes surface as an `AbortError` instead of a `TimeoutError` (especially in automated test environments).

If you need to distinguish between these cases, check for both error types in your error handling logic:

```typescript
try {
  await client('https://example.com')
} catch (err) {
  if (err instanceof TimeoutError || (err instanceof AbortError && /* context indicates timeout */)) {
    // handle timeout
  } else if (err instanceof AbortError) {
    // handle user abort
  }
}
```

This is a pragmatic workaround for cross-environment compatibility.

## Planned Features

- Middleware support
- Built-in caching

## License

MIT © 2025 gkoos
