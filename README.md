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

✨ **Key Features:**

- **Timeouts** – per-request or global
- **Retries** – exponential backoff + jitter
- **Circuit breaker** – automatic failure protection
- **Hooks** – logging, auth, metrics, request/response transformation
- **Pending requests** – real-time monitoring of active requests
- **Per-request overrides** – customize behavior on a per-request basis
- **Universal** – Node.js, Browser, Cloudflare Workers, React Native
- **Zero runtime deps** – ships as dual ESM/CJS

## Quick Start

### Install

```bash
npm install @gkoos/ffetch
```

### Basic Usage

```typescript
import createClient from '@gkoos/ffetch'

// Create a client with timeout and retries
const api = createClient({
  timeout: 5000,
  retries: 3,
  retryDelay: ({ attempt }) => 2 ** attempt * 100 + Math.random() * 100,
})

// Make requests
const response = await api('https://api.example.com/users')
const data = await response.json()
```

### Advanced Example

```typescript
// Production-ready client with error handling and monitoring
const client = createClient({
  timeout: 10000,
  retries: 2,
  circuit: { threshold: 5, reset: 30000 },
  hooks: {
    before: async (req) => console.log('→', req.url),
    after: async (req, res) => console.log('←', res.status),
    onError: async (req, err) => console.error('Error:', err.message),
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

## Documentation

| Topic                                         | Description                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| **[Complete Documentation](./docs/index.md)** | **Start here** - Documentation index and overview                         |
| **[API Reference](./docs/api.md)**            | Complete API documentation and configuration options                      |
| **[Advanced Features](./docs/advanced.md)**   | Per-request overrides, pending requests, circuit breakers, custom errors  |
| **[Hooks & Transformation](./docs/hooks.md)** | Lifecycle hooks, authentication, logging, request/response transformation |
| **[Usage Examples](./docs/examples.md)**      | Real-world patterns: REST clients, GraphQL, file uploads, microservices   |
| **[Compatibility](./docs/compatibility.md)**  | Browser/Node.js support, polyfills, framework integration                 |

## Environment Requirements

`ffetch` requires modern AbortSignal APIs:

- **Node.js 18.8+** (or polyfill for older versions)
- **Modern browsers** (Chrome 88+, Firefox 89+, Safari 15.4+, Edge 88+)

For older environments, see the [compatibility guide](./docs/compatibility.md).

## CDN Usage

```html
<script type="module">
  import createClient from 'https://unpkg.com/@gkoos/ffetch/dist/index.min.js'

  const api = createClient({ timeout: 5000 })
  const data = await api('/api/data').then((r) => r.json())
</script>
```

## Fetch vs. Axios vs. `ffetch`

| Feature            | Native Fetch              | Axios                | ffetch                           |
| ------------------ | ------------------------- | -------------------- | -------------------------------- |
| Timeouts           | ❌ Manual AbortController | ✅ Built-in          | ✅ Built-in with fallbacks       |
| Retries            | ❌ Manual implementation  | ❌ Manual or plugins | ✅ Smart exponential backoff     |
| Circuit Breaker    | ❌ Not available          | ❌ Manual or plugins | ✅ Automatic failure protection  |
| Request Monitoring | ❌ Manual tracking        | ❌ Manual tracking   | ✅ Built-in pending requests     |
| Error Types        | ❌ Generic errors         | ⚠️ HTTP errors only  | ✅ Specific error classes        |
| TypeScript         | ⚠️ Basic types            | ⚠️ Basic types       | ✅ Full type safety              |
| Hooks/Middleware   | ❌ Not available          | ✅ Interceptors      | ✅ Comprehensive lifecycle hooks |
| Bundle Size        | ✅ Native (0kb)           | ❌ ~13kb minified    | ✅ ~3kb minified                 |
| Modern APIs        | ✅ Web standards          | ❌ XMLHttpRequest    | ✅ Fetch + modern features       |

## Contributing

- **Issues**: [GitHub Issues](https://github.com/gkoos/ffetch/issues)
- **Pull Requests**: [GitHub PRs](https://github.com/gkoos/ffetch/pulls)
- **Documentation**: Found in `./docs/` - PRs welcome!

## License

MIT © 2025 gkoos
