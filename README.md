# @gkoos/ffetch

**A TypeScript-first fetch wrapper that adds production-grade resilience in <4 kB.**

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

## Quick Start

```typescript
import createClient from '@gkoos/ffetch'

const f = createClient({
  timeout: 5000,
  retries: 3,
  retryDelay: (n) => 2 ** n * 100 + Math.random() * 100,
})

const res = await f('https://api.example.com/v1/users')
const data = await res.json()
```

## API

createClient(options?)

| Option       | Type & default                                                                                                            | Description                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `timeout`    | `number` (ms)                                                                                                             | whole-request timeout                      |
| `retries`    | `number` (0)                                                                                                              | max retry attempts                         |
| `retryDelay` | `number \| fn` (exponential backoff + jitter)                                                                             | delay between retries                      |
| `circuit`    | `{ threshold, reset }`                                                                                                    | circuit-breaker rules                      |
| `hooks`      | `{ before, after, onError, onRetry, onTimeout, onAbort, onCircuitOpen, onComplete, transformRequest, transformResponse }` | lifecycle hooks/interceptors, transformers |

Returns a fetch-like function:

```typescript
type FFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>
```

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
  retryDelay: (attempt) => 100 * attempt, // linear backoff for this request
})

// Override hooks for a single request
await f('https://api.example.com/v1/metrics', {
  hooks: {
    before: (req) => console.log('Single request:', req.url),
  },
})
```

### Custom Error Types

`ffetch` throws custom error classes for robust error handling. You can catch and handle these errors as needed:

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

### Note on Timeout vs Abort Errors

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

### License

MIT © 2025 gkoos
