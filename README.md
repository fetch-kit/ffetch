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
import { createClient } from '@gkoos/ffetch'

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

### Circuit breaker

```typescript
const f = createClient({
  retries: 0, // let breaker handle
  circuit: { threshold: 5, reset: 30_000 },
})
```

### Hooks

```typescript
const f = createClient({
  hooks: {
    before: async (req) => console.log('→', req.url),
    after: async (req, res) => console.log('←', res.status),
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

### License

MIT © 2025 gkoos
