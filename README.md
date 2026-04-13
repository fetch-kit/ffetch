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

ffetch uses a plugin architecture for optional features, so you only include what you need.

## Why ffetch

- Keep native fetch ergonomics, add production safety (timeouts, retries, error strategy).
- Keep your runtime flexibility (use global fetch or any fetch-compatible handler).
- Keep your bundle lean – **~3kb minified** (optional plugins, zero runtime dependencies).

## Table of Contents

- [@fetchkit/ffetch](#fetchkitffetch)
  - [Why ffetch](#why-ffetch)
  - [Table of Contents](#table-of-contents)
  - [Key Features](#key-features)
    - [Built-in Plugins at a Glance](#built-in-plugins-at-a-glance)
  - [What Problems Does ffetch Solve?](#what-problems-does-ffetch-solve)
  - [Quick Start](#quick-start)
    - [Install](#install)
    - [Basic Setup](#basic-setup)
    - [Production Setup with Plugins](#production-setup-with-plugins)
    - [Why not only native fetch?](#why-not-only-native-fetch)
    - [Common Recipes](#common-recipes)
    - [Using a Custom fetchHandler (SSR, metaframeworks, or polyfills)](#using-a-custom-fetchhandler-ssr-metaframeworks-or-polyfills)
    - [Advanced Example](#advanced-example)
    - [Custom Error Handling with `throwOnHttpError`](#custom-error-handling-with-throwonhttperror)
  - [Documentation](#documentation)
  - [Environment Requirements](#environment-requirements)
    - ["AbortSignal.any is not a function"](#abortsignalany-is-not-a-function)
  - [CDN Usage](#cdn-usage)
  - [Deduplication Limitations](#deduplication-limitations)
  - [Fetch vs. Axios vs. ky vs. `ffetch`](#fetch-vs-axios-vs-ky-vs-ffetch)
    - [Try ffetch in Action](#try-ffetch-in-action)
  - [Join the Community](#join-the-community)
  - [Contributing](#contributing)
  - [License](#license)

## Key Features

- **Timeouts** – per-request or global
- **Retries** – exponential backoff + jitter
- **Abort-aware retries** – aborting during backoff cancels immediately
- **Plugin architecture** – extensible lifecycle-based plugins for optional behavior
- **Hooks** – logging, auth, metrics, request/response transformation
- **Pending requests** – real-time monitoring of active requests
- **Per-request overrides** – customize behavior on a per-request basis
- **Universal** – Node.js, Browser, Cloudflare Workers, React Native
- **Zero runtime deps** – ships as dual ESM/CJS
- **Configurable error handling** – custom error types and `throwOnHttpError` flag to throw on HTTP errors
- **Bulkhead plugin (optional, prebuilt)** – cap concurrency and queue depth per client instance
- **Circuit breaker plugin (optional, prebuilt)** – automatic failure protection
- **Hedge plugin (optional, prebuilt)** – race parallel attempts to reduce tail latency
- **Deduplication plugin (optional, prebuilt)** – automatic deduping of in-flight identical requests
- **Request shortcuts plugin (optional, prebuilt)** – call `client.get(url)` / `.post()` / `.put()` / `.patch()` / `.delete()` directly on the client
- **Response shortcuts plugin (optional, prebuilt)** – call `client(url).json()` / `.text()` / `.blob()` directly on the request promise
- **Download progress plugin (optional, prebuilt)** – stream download progress callbacks with bytes transferred and percentage

**Built-in error classes:** `TimeoutError`, `RetryLimitError`, `CircuitOpenError`, `BulkheadFullError`, `HttpError`, `NetworkError`, `AbortError`

### Built-in Plugins at a Glance

All plugins are tree-shakeable — import only what you use.

- **dedupePlugin (optional)**: dedupe in-flight identical requests.
- **bulkheadPlugin (optional)**: cap in-flight concurrency with optional queue backpressure.
- **hedgePlugin (optional)**: race multiple attempts and cancel losers when a winner is found.
- **circuitPlugin (optional)**: fail fast after repeated failures.
- **requestShortcutsPlugin (optional)**: HTTP method shortcuts on the client (`.get()` / `.post()` / `.put()` / `.patch()` / `.delete()` / `.head()` / `.options()`).
- **responseShortcutsPlugin (optional)**: use `client(url).json()` / `.text()` / `.blob()` style parsing.
- **downloadProgressPlugin (optional)**: stream download progress via `onProgress(progress, chunk)` callback.

## What Problems Does ffetch Solve?

ffetch is ideal for:

- **Microservices and REST APIs** with retry requirements and timeout control
- **High-traffic client applications** that need in-flight deduplication and circuit breaker protection
- **SSR and metaframework apps** that require runtime flexibility (custom fetch handlers for different environments)
- **Type-safe request handling** with strong TypeScript support and zero runtime dependencies

## Quick Start

Migrating from v4? Start with the [migration guide](./docs/migration.md) before applying the examples below.

### Install

```bash
# npm
npm install @fetchkit/ffetch

# yarn
yarn add @fetchkit/ffetch

# pnpm
pnpm add @fetchkit/ffetch

# bun
bun add @fetchkit/ffetch
```

### Basic Setup

```typescript
import { createClient } from '@fetchkit/ffetch'

type User = { id: number; name: string }

const api = createClient({ timeout: 5000, retries: 2 })
const response = await api('https://api.example.com/users')

if (!response.ok) {
  throw new Error(`Request failed: ${response.status}`)
}

const users = (await response.json()) as User[]
```

### Production Setup with Plugins

```typescript
import { createClient } from '@fetchkit/ffetch'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'
import { requestShortcutsPlugin } from '@fetchkit/ffetch/plugins/request-shortcuts'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'

const api = createClient({
  timeout: 10_000,
  retries: 2,
  plugins: [
    // 1) Optional: dedupe identical in-flight requests
    dedupePlugin({ ttl: 30_000, sweepInterval: 5_000 }),
    // 2) Optional: open the circuit after repeated failures
    circuitPlugin({ threshold: 5, reset: 30_000 }),
    // 3) Optional: enable request-promise parsing shortcuts
    responseShortcutsPlugin(),
    // 4) Optional: enable client HTTP method shortcuts
    requestShortcutsPlugin(),
  ],
})

const users = await api
  .get('https://api.example.com/users')
  .json<Array<{ id: number; name: string }>>()

const p1 = api('https://api.example.com/data')
const p2 = api('https://api.example.com/data')
const [res1, res2] = await Promise.all([p1, p2])
```

What this setup gives you:

- **Operational safety**: retries with timeout defaults.
- **Lower duplicate traffic (optional)**: concurrent identical requests share one in-flight call.
- **Faster failure recovery (optional)**: circuit breaker blocks repeated failing calls.
- **Cleaner request ergonomics (optional)**: `client.get(url)` / `.post(url, init)` style shortcuts.
- **Cleaner parsing (optional)**: `client(url).json()` style shortcuts.

### Why not only native fetch?

- Native fetch is a great baseline, but production apps usually need retries and timeout control.
- ffetch keeps the fetch model and adds optional resilience features.
- You can keep strict native behavior and only opt into plugins you need.

### Common Recipes

```typescript
// Throw on non-2xx/429 once retries are exhausted
const strict = createClient({ throwOnHttpError: true })

// Use a custom fetch implementation (SSR/framework/runtime)
import nodeFetch from 'node-fetch'
const apiWithCustomHandler = createClient({ fetchHandler: nodeFetch })

// Keep native Response flow (works with or without plugins)
const plainApi = createClient({ timeout: 5000 })
const response = await plainApi('https://api.example.com/health')
const text = await response.text()
```

### Using a Custom fetchHandler (SSR, metaframeworks, or polyfills)

```typescript
// Why this exists:
// ffetch wraps whatever fetch-compatible function you provide.
// This is useful when your runtime has a scoped/framework fetch,
// or when Node needs an explicit fetch implementation.

import { createClient } from '@fetchkit/ffetch'
import nodeFetch from 'node-fetch'

// Node.js example: provide node-fetch explicitly
const apiNode = createClient({
  fetchHandler: nodeFetch,
  timeout: 5000,
})
const nodeResponse = await apiNode('https://api.example.com/data')

// Framework example: pass the framework-scoped fetch
// (e.g. the fetch passed into a request handler)
async function loadData(frameworkFetch: typeof fetch) {
  const api = createClient({
    fetchHandler: frameworkFetch,
    timeout: 5000,
  })

  const response = await api('/internal/data')
  return response.json()
}
```

All ffetch features (timeouts, retries, plugins, hooks) behave the same with a custom `fetchHandler`.

With `responseShortcutsPlugin()` enabled, request-promise shortcuts like `api(url).json()` also work the same.

### Advanced Example

```typescript
// Production-ready client with error handling and monitoring
import { createClient } from '@fetchkit/ffetch'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'

const client = createClient({
  timeout: 10000,
  retries: 2,
  fetchHandler: fetch, // Use custom fetch if needed
  plugins: [
    dedupePlugin({
      hashFn: (params) => `${params.method}|${params.url}|${params.body}`,
      ttl: 30_000,
      sweepInterval: 5_000,
    }),
    circuitPlugin({
      threshold: 5,
      reset: 30_000,
      onCircuitOpen: ({ request, reason }) =>
        console.warn('Circuit opened due to:', request.url, reason.type),
      onCircuitClose: ({ request, response }) =>
        console.info('Circuit closed after:', request.url, response.status),
    }),
  ],
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

### Custom Error Handling with `throwOnHttpError`

Native `fetch`'s controversial behavior of not throwing errors for HTTP error status codes (4xx, 5xx) can lead to overlooked errors in applications. By default, `ffetch` follows this same pattern, returning a `Response` object regardless of the HTTP status code. However, with the `throwOnHttpError` flag, developers can configure `ffetch` to throw an `HttpError` for HTTP error responses, making error handling more explicit and robust. Note that this behavior is affected by retries and the circuit breaker - full details are explained in the [Error Handling documentation](./docs/errorhandling.md).

## Documentation

| Topic                                                        | Description                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **[Complete Documentation](./docs/index.md)**                | **Start here** - Documentation index and overview                         |
| **[API Reference](./docs/api.md)**                           | Complete API documentation and configuration options                      |
| **[Plugin Architecture](./docs/plugins.md)**                 | Plugin lifecycle, custom plugin authoring, and integration patterns       |
| **[Deduplication](./docs/deduplication.md)**                 | How deduplication works, hash config, optional TTL cleanup, limitations   |
| **[Error Handling](./docs/errorhandling.md)**                | Strategies for managing errors, including `throwOnHttpError`              |
| **[Advanced Features](./docs/advanced.md)**                  | Per-request overrides, pending requests, circuit breakers, custom errors  |
| **[Production Operations](./docs/production-operations.md)** | Pre-deploy checklist, alerting baseline, and incident playbook            |
| **[Hooks & Transformation](./docs/hooks.md)**                | Lifecycle hooks, authentication, logging, request/response transformation |
| **[Usage Examples](./docs/examples.md)**                     | Real-world patterns: REST clients, GraphQL, file uploads, microservices   |
| **[Compatibility](./docs/compatibility.md)**                 | Browser/Node.js support, polyfills, framework integration                 |

## Environment Requirements

`ffetch` works best with native `AbortSignal.any` support:

- **Node.js 20.6+** (native `AbortSignal.any`)
- **Modern browsers with `AbortSignal.any`** (for example: Chrome 117+, Firefox 117+, Safari 17+, Edge 117+)

If your environment does not support `AbortSignal.any` (Node.js < 20.6, older browsers), you can still use ffetch by installing an `AbortSignal.any` polyfill. `AbortSignal.timeout` is optional because ffetch includes an internal timeout fallback. See the [compatibility guide](./docs/compatibility.md) for instructions.

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
  import { createClient } from 'https://unpkg.com/@fetchkit/ffetch/dist/index.min.js'

  const api = createClient({ timeout: 5000 })
  const data = await api('/api/data').then((r) => r.json())
</script>
```

## Deduplication Limitations

- Deduplication is **off** by default. Enable it via `plugins: [dedupePlugin()]`.
- The default hash function is `dedupeRequestHash`, which handles common body types and skips deduplication for streams and FormData.
- Optional stale-entry cleanup: `dedupePlugin({ ttl, sweepInterval })` enables map-entry eviction. TTL eviction only removes dedupe keys; it does not reject already in-flight promises.
- **Stream bodies** (`ReadableStream`, `FormData`): Deduplication is skipped for requests with these body types, as they cannot be reliably hashed or replayed.
- **Non-idempotent requests**: Use deduplication with caution for non-idempotent methods (e.g., POST), as it may suppress multiple intended requests.
- **Custom hash function**: Ensure your hash function uniquely identifies requests to avoid accidental deduplication.

See [deduplication.md](./docs/deduplication.md) for full details.

## Fetch vs. Axios vs. ky vs. `ffetch`

| Feature              | Native Fetch                                            | Axios                          | ky                                            | ffetch                                                                                 |
| -------------------- | ------------------------------------------------------- | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Timeouts             | ❌ Manual AbortController                               | ✅ Built-in                    | ✅ Built-in                                   | ✅ Built-in with fallbacks                                                             |
| Retries              | ❌ Manual implementation                                | ❌ Manual or plugins           | ✅ Built-in                                   | ✅ Smart exponential backoff                                                           |
| Response Parsing DX  | ⚠️ Response methods only (`await fetch(...).then(...)`) | ✅ `response.data` convenience | ✅ `.json()/.text()/.blob()` on request chain | ✅ Optional `responseShortcutsPlugin()` (`.json()/.text()/.blob()` on request chain)   |
| Plugin Architecture  | ❌ Not available                                        | ⚠️ Interceptors only           | ⚠️ Hook-based extensions                      | ✅ First-class plugin pipeline (optional built-in + custom plugins)                    |
| Circuit Breaker      | ❌ Not available                                        | ❌ Manual or plugins           | ❌ Manual                                     | ✅ Automatic failure protection                                                        |
| Deduplication        | ❌ Not available                                        | ❌ Not available               | ❌ Not available                              | ✅ Optional via `dedupePlugin()`                                                       |
| Bulkheading          | ❌ Not available                                        | ❌ Not available               | ❌ Not available                              | ✅ Optional via `bulkheadPlugin()`                                                     |
| Request Hedging      | ❌ Not available                                        | ❌ Not available               | ❌ Not available                              | ✅ Optional via `hedgePlugin()` (tail latency reduction)                               |
| Request Monitoring   | ❌ Manual tracking                                      | ❌ Manual tracking             | ❌ Manual tracking                            | ✅ Built-in pending requests                                                           |
| Error Types          | ❌ Generic errors                                       | ⚠️ HTTP errors only            | ✅ Specific error classes                     | ✅ Specific error classes                                                              |
| TypeScript           | ⚠️ Basic types                                          | ⚠️ Basic types                 | ✅ Strong types                               | ✅ Full type safety                                                                    |
| Hooks/Middleware     | ❌ Not available                                        | ✅ Interceptors                | ✅ Hooks                                      | ✅ Comprehensive lifecycle hooks                                                       |
| Bundle Size          | ✅ Native (0kb)                                         | ❌ ~13kb minified              | ✅ Lightweight (fetch-based)                  | ✅ ~3kb minified                                                                       |
| Modern APIs          | ✅ Web standards                                        | ❌ XMLHttpRequest              | ✅ Fetch + modern APIs                        | ✅ Fetch + modern features                                                             |
| Download Progress    | ❌ Manual ReadableStream                                | ❌ Manual                      | ✅ `onDownloadProgress` callback              | ✅ Optional via `downloadProgressPlugin()`                                             |
| Custom Fetch Support | ❌ No (global only)                                     | ❌ No                          | ❌ No                                         | ✅ Yes (wrap any fetch-compatible implementation, including framework or custom fetch) |

Note: built-in plugins in ffetch are opt-in. Use `bulkheadPlugin()` for concurrency isolation and backpressure, `dedupePlugin()` for deduplication, `circuitPlugin()` for circuit breaking, `hedgePlugin()` for tail-latency racing, `requestShortcutsPlugin()` for client HTTP method shortcuts, `responseShortcutsPlugin()` for request-promise parsing shortcuts, and `downloadProgressPlugin()` for streaming download progress. Bundle size: ~3kb core, additional optional plugin imports are tree-shakeable.

### Try ffetch in Action

Want to see these clients in practice? Check out [ffetch-demo](https://github.com/fetch-kit/ffetch-demo) for working examples and side-by-side comparisons of how ffetch simplifies common fetch patterns.

## Join the Community

Got questions, want to discuss features, or share examples? Join the **Fetch-Kit Discord server**:

[![Discord](https://img.shields.io/badge/Discord-Join_Fetch--Kit-7289DA?logo=discord&logoColor=white)](https://discord.gg/sdyPBPCDUg)

## Contributing

- **Issues**: [GitHub Issues](https://github.com/fetch-kit/ffetch/issues)
- **Pull Requests**: [GitHub PRs](https://github.com/fetch-kit/ffetch/pulls)
- **Documentation**: Found in `./docs/` - PRs welcome!

## License

MIT © 2025 gkoos
