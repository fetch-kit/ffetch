# @gkoos/ffetch

**A tiny, TypeScript-first fetch wrapper that adds production-grade resilience in <4 kB.**

- ✅ **Timeouts** – per-request or global
- ✅ **Retries** – exponential back-off + jitter
- ✅ **Circuit breaker** – trip after N failures
- ✅ **Hooks** – logging, auth, metrics
- ✅ **Universal** – Node, Browser, Cloudflare Workers, React Native
- ✅ **Zero runtime deps** – ships as dual ESM/CJS

## Install

````bash
npm install @gkoos/ffetch

## Quick Start

```typescript
import { createClient } from '@gkoos/ffetch'

const f = createClient({
  timeout: 5000,
  retries: 3,
  retryDelay: n => 2 ** n * 100 + Math.random() * 100,
})

const data = await f('https://api.example.com/v1/users').then(r => r.json())
````

## API

createClient(options?)

| Option       | Type & default                                                                       | Description                  |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------- |
| `timeout`    | `number` (ms)                                                                        | whole-request timeout        |
| `retries`    | `number` (0)                                                                         | max retry attempts           |
| `retryDelay` | `number \| fn` (exponential backoff + jitter)                                        | delay between retries        |
| `circuit`    | `{ threshold, reset }`                                                               | circuit-breaker rules        |
| `hooks`      | `{ before, after, onError, onRetry, onTimeout, onAbort, onCircuitOpen, onComplete }` | lifecycle hooks/interceptors |

Returns a fetch-like function:

```typescript
type FFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>
```

## Advanced

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

### License

MIT © 2025 gkoos
