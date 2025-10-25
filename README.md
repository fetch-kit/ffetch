![npm](https://img.shields.io/npm/v/@fetchkit/ffetch)
![Downloads](https://img.shields.io/npm/dm/@fetchkit/ffetch)
![GitHub stars](https://img.shields.io/github/stars/fetch-kit/ffetch?style=social)

![Build](https://github.com/fetch-kit/ffetch/actions/workflows/ci.yml/badge.svg)
![codecov](https://codecov.io/gh/fetch-kit/ffetch/branch/main/graph/badge.svg)

![MIT](https://img.shields.io/npm/l/@fetchkit/ffetch)
![bundlephobia](https://badgen.net/bundlephobia/minzip/@fetchkit/ffetch)
![Types](https://img.shields.io/npm/types/@fetchkit/ffetch)

# @fetchkit/ffetch

**A production-ready TypeScript-first drop-in replacement for native fetch, or any fetch-compatible implementation.**

ffetch can wrap any fetch-compatible implementation (native fetch, node-fetch, undici, or framework-provided fetch), making it flexible for SSR, edge, and custom environments.

**Key Features:**

- **Timeouts** – per-request or global
- **Retries** – exponential backoff + jitter
- **Circuit breaker** – automatic failure protection
- **Deduplication** – automatic deduping of in-flight identical requests
- **Hooks** – logging, auth, metrics, request/response transformation
- **Pending requests** – real-time monitoring of active requests
- **Per-request overrides** – customize behavior on a per-request basis
- **Universal** – Node.js, Browser, Cloudflare Workers, React Native
- **Zero runtime deps** – ships as dual ESM/CJS
- **Configurable error handling** – custom error types and `throwOnHttpError` flag to throw on HTTP errors

## Quick Start

### Install

```bash
npm install @fetchkit/ffetch
```

### Basic Usage

```typescript
import createClient from '@fetchkit/ffetch'

// Create a client with timeout, retries, and deduplication
const api = createClient({
  timeout: 5000,
  retries: 3,
  dedupe: true, // Enable deduplication globally
  retryDelay: ({ attempt }) => 2 ** attempt * 100 + Math.random() * 100,
})

// Make requests
const response = await api('https://api.example.com/users')
const data = await response.json()

// Deduplication example: these two requests will be deduped
const p1 = api('https://api.example.com/data')
const p2 = api('https://api.example.com/data')
const [r1, r2] = await Promise.all([p1, p2])
// Only one fetch will occur; both promises resolve to the same response
```

### Using a Custom fetchHandler (SSR, metaframeworks, or polyfills)

```typescript
// Example: SvelteKit, Next.js, Nuxt, or node-fetch
import createClient from '@fetchkit/ffetch'

// Pass your framework's fetch implementation
const api = createClient({
  fetchHandler: fetch, // SvelteKit/Next.js/Nuxt provide their own fetch
  timeout: 5000,
})

// Or use node-fetch/undici in Node.js
import nodeFetch from 'node-fetch'
const apiNode = createClient({ fetchHandler: nodeFetch })

// All ffetch features work identically
const response = await api('/api/data')
```

### Advanced Example

```typescript
// Production-ready client with error handling and monitoring
const client = createClient({
  timeout: 10000,
  retries: 2,
  dedupe: true,
  dedupeHashFn: (params) => `${params.method}|${params.url}|${params.body}`,
  circuit: { threshold: 5, reset: 30000 },
  fetchHandler: fetch, // Use custom fetch if needed
  hooks: {
    before: async (req) => console.log('→', req.url),
    after: async (req, res) => console.log('←', res.status),
    onError: async (req, err) => console.error('Error:', err.message),
    onCircuitOpen: (req) => console.warn('Circuit opened due to:', req.url),
    onCircuitClose: (req) => console.info('Circuit closed after:', req.url),
  },
})

try {
  const response = await client('/api/data')

  // Check HTTP status manually (like native fetch)
  if (!response.ok) {
    console.log('HTTP error:', response.status)
    return
  }

  const data = await response.json()
  console.log('Active requests:', client.pendingRequests.length)
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log('Request timed out')
  } else if (err instanceof RetryLimitError) {
    console.log('Request failed after retries')
  }
}
```

### Custom Error Handling with `throwOnHttpError`

Native `fetch`'s controversial behavior of not throwing errors for HTTP error status codes (4xx, 5xx) can lead to overlooked errors in applications. By default, `ffetch` follows this same pattern, returning a `Response` object regardless of the HTTP status code. However, with the `throwOnHttpError` flag, developers can configure `ffetch` to throw an `HttpError` for HTTP error responses, making error handling more explicit and robust. Note that this behavior is affected by retries and the circuit breaker - full details are explained in the [Error Handling documentation](./docs/errorhandling.md).

## Documentation

| Topic                                         | Description                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| **[Complete Documentation](./docs/index.md)** | **Start here** - Documentation index and overview                         |
| **[API Reference](./docs/api.md)**            | Complete API documentation and configuration options                      |
| **[Deduplication](./docs/deduplication.md)**  | How deduplication works, config, custom hash, limitations                 |
| **[Error Handling](./docs/errorhandling.md)** | Strategies for managing errors, including `throwOnHttpError`              |
| **[Advanced Features](./docs/advanced.md)**   | Per-request overrides, pending requests, circuit breakers, custom errors  |
| **[Hooks & Transformation](./docs/hooks.md)** | Lifecycle hooks, authentication, logging, request/response transformation |
| **[Usage Examples](./docs/examples.md)**      | Real-world patterns: REST clients, GraphQL, file uploads, microservices   |
| **[Compatibility](./docs/compatibility.md)**  | Browser/Node.js support, polyfills, framework integration                 |

## Environment Requirements

`ffetch` requires modern AbortSignal APIs:

- **Node.js 20.6+** (for AbortSignal.any)
- **Modern browsers** (Chrome 117+, Firefox 117+, Safari 17+, Edge 117+)

If your environment does not support `AbortSignal.any` (Node.js < 20.6, older browsers), you **must install a polyfill** before using ffetch. See the [compatibility guide](./docs/compatibility.md) for instructions.

**Custom fetch support:**
You can pass any fetch-compatible implementation (native fetch, node-fetch, undici, SvelteKit, Next.js, Nuxt, or a polyfill) via the `fetchHandler` option. This makes ffetch fully compatible with SSR, edge, metaframework environments, custom backends, and test runners.

#### "AbortSignal.any is not a function"

Solution: Install a polyfill for `AbortSignal.any`

```bash
npm install abort-controller-x
```

## CDN Usage

```html
<script type="module">
  import createClient from 'https://unpkg.com/@fetchkit/ffetch/dist/index.min.js'

  const api = createClient({ timeout: 5000 })
  const data = await api('/api/data').then((r) => r.json())
</script>
```

## Deduplication Limitations

- Deduplication is **off** by default. Enable it via the `dedupe` option.
- The default hash function is `dedupeRequestHash`, which handles common body types and skips deduplication for streams and FormData.
- **Stream bodies** (`ReadableStream`, `FormData`): Deduplication is skipped for requests with these body types, as they cannot be reliably hashed or replayed.
- **Non-idempotent requests**: Use deduplication with caution for non-idempotent methods (e.g., POST), as it may suppress multiple intended requests.
- **Custom hash function**: Ensure your hash function uniquely identifies requests to avoid accidental deduplication.

See [deduplication.md](./docs/deduplication.md) for full details.

## Fetch vs. Axios vs. `ffetch`

| Feature              | Native Fetch              | Axios                | ffetch                                                                                 |
| -------------------- | ------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Timeouts             | ❌ Manual AbortController | ✅ Built-in          | ✅ Built-in with fallbacks                                                             |
| Retries              | ❌ Manual implementation  | ❌ Manual or plugins | ✅ Smart exponential backoff                                                           |
| Circuit Breaker      | ❌ Not available          | ❌ Manual or plugins | ✅ Automatic failure protection                                                        |
| Deduplication        | ❌ Not available          | ❌ Not available     | ✅ Automatic deduplication of in-flight identical requests                             |
| Request Monitoring   | ❌ Manual tracking        | ❌ Manual tracking   | ✅ Built-in pending requests                                                           |
| Error Types          | ❌ Generic errors         | ⚠️ HTTP errors only  | ✅ Specific error classes                                                              |
| TypeScript           | ⚠️ Basic types            | ⚠️ Basic types       | ✅ Full type safety                                                                    |
| Hooks/Middleware     | ❌ Not available          | ✅ Interceptors      | ✅ Comprehensive lifecycle hooks                                                       |
| Bundle Size          | ✅ Native (0kb)           | ❌ ~13kb minified    | ✅ ~3kb minified                                                                       |
| Modern APIs          | ✅ Web standards          | ❌ XMLHttpRequest    | ✅ Fetch + modern features                                                             |
| Custom Fetch Support | ❌ No (global only)       | ❌ No                | ✅ Yes (wrap any fetch-compatible implementation, including framework or custom fetch) |

## Join the Community

Got questions, want to discuss features, or share examples? Join the **Fetch-Kit Discord server**:

[![Discord](https://img.shields.io/badge/Discord-Join_Fetch--Kit-7289DA?logo=discord&logoColor=white)](https://discord.gg/sdyPBPCDUg)

## Contributing

- **Issues**: [GitHub Issues](https://github.com/fetch-kit/ffetch/issues)
- **Pull Requests**: [GitHub PRs](https://github.com/fetch-kit/ffetch/pulls)
- **Documentation**: Found in `./docs/` - PRs welcome!

## License

MIT © 2025 gkoos
