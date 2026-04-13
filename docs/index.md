# Documentation Index

## **Documentation Structure**

### **Quick Start**

- **[README.md](../README.md)** - Installation, basic usage, and overview

### **API Reference**

- **[api.md](./api.md)** - Complete API documentation
  - `createClient()` options and return types
  - Configuration parameters and defaults
  - TypeScript interfaces and types

### **Plugin Architecture**

- **[plugins.md](./plugins.md)** - Plugin lifecycle, ordering, custom plugin authoring
  - Built-in feature plugins (`dedupe`, `circuit`, `request-shortcuts`, `response-shortcuts`)
  - Writing and registering custom plugins
  - Public plugin types and extension patterns

### **Getting Started**

- **[migration.md](./migration.md)** - Migration guide from native fetch to ffetch
  - Drop-in replacement patterns
  - Error handling differences
  - v4 -> v5 plugin migration (`dedupe`/`circuit` flags -> plugins)
  - New capabilities and features
  - TypeScript migration tips

### **Advanced Features**

- **[advanced.md](./advanced.md)** - Advanced patterns and features
  - Per-request overrides
  - Pending requests monitoring
  - Retry strategies and circuit breakers
  - Custom error handling

- **[hedging.md](./hedging.md)** - Reduce tail latency by racing parallel attempts
  - Hedging plugin configuration and behavior
  - Delay strategies and max hedges
  - Integration with retries and circuit breakers
  - Performance tuning for high-latency endpoints

### **Hooks & Transformation**

- **[hooks.md](./hooks.md)** - Lifecycle hooks and request/response transformation
  - All available hooks (`before`, `after`, `onError`, etc.)
  - Request and response transformation
  - Authentication, logging, and caching patterns

### **Usage Examples**

- **[examples.md](./examples.md)** - Real-world examples and patterns
  - REST API clients
  - Microservices integration
  - GraphQL clients
  - File uploads and polling
  - Error handling strategies

### **Compatibility Guide**

- **[compatibility.md](./compatibility.md)** - Browser and Node.js compatibility
  - Environment requirements
  - Polyfills and fallbacks
  - Framework integration (React, Vue, Svelte)
  - Troubleshooting common issues

## **Getting Started**

1. **Start with the [README](../README.md)** for installation and basic usage
2. **Check [compatibility.md](./compatibility.md)** to ensure your environment is supported
3. **Read [api.md](./api.md)** for complete configuration options
4. **Read [plugins.md](./plugins.md)** to understand plugin architecture and custom extensions
5. **Explore [examples.md](./examples.md)** for patterns that match your use case
6. **Dive into [advanced.md](./advanced.md)** and [hooks.md](./hooks.md)\*\* for powerful features

## **Finding What You Need**

### **I want to...**

| Goal                                             | Documentation                                                |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Get started quickly                              | [README.md](../README.md)                                    |
| Error handling                                   | [errorhandling.md](./errorhandling.md)                       |
| Deduplicate requests (with optional TTL cleanup) | [deduplication.md](./deduplication.md)                       |
| Migrate from native fetch                        | [migration.md](./migration.md)                               |
| Understand plugin architecture                   | [plugins.md](./plugins.md)                                   |
| Write a custom plugin                            | [plugins.md](./plugins.md#writing-a-custom-plugin)           |
| See all configuration options                    | [api.md](./api.md)                                           |
| Handle errors gracefully                         | [advanced.md](./advanced.md#custom-error-handling)           |
| Add authentication to requests                   | [hooks.md](./hooks.md#authentication)                        |
| Build a REST API client                          | [examples.md](./examples.md#rest-api-client)                 |
| Monitor active requests                          | [advanced.md](./advanced.md#pending-requests-monitoring)     |
| Implement retry logic                            | [advanced.md](./advanced.md#retry-strategies-and-backoff)    |
| Use with React/Vue/Svelte                        | [compatibility.md](./compatibility.md#framework-integration) |
| Debug connection issues                          | [compatibility.md](./compatibility.md#troubleshooting)       |
| Transform requests/responses                     | [hooks.md](./hooks.md#requestresponse-transformation)        |
| Handle rate limiting                             | [examples.md](./examples.md#rate-limiting-and-backpressure)  |
| Cache responses                                  | [examples.md](./examples.md#caching-with-ttl)                |
| Use `client.get()` / `client.post()` shortcuts   | [api.md](./api.md#request-shortcuts-plugin)                  |
| Use `client(url).json()` style shortcuts         | [api.md](./api.md#response-shortcuts-plugin)                 |
| Reduce tail latency with parallel attempts       | [hedging.md](./hedging.md)                                   |

## **Key Concepts**

### **Core Features**

- **Timeouts**: Per-request or global timeout configuration
- **Retries**: Exponential backoff with jitter and custom retry logic
- **Plugin-based optional features**: Circuit breaker, dedupe, and third-party plugins
- **Hooks**: Lifecycle events for logging, auth, and transformation
- **Pending Requests**: Real-time monitoring of active requests
- **Custom fetch wrapping**: Pluggable fetch implementation for SSR, node-fetch, undici, and framework-provided fetch

### **Error Handling**

- Custom error types (`TimeoutError`, `RetryLimitError`, etc.)
- Graceful degradation patterns
- Circuit breaker for service protection
- Comprehensive error context

### **Flexibility**

- Per-request option overrides
- Pluggable retry and timeout strategies
- Request/response transformation
- Universal compatibility (Node.js, browsers, workers)

## **Common Patterns**

### **Basic HTTP Client**

```typescript
import { createClient } from '@fetchkit/ffetch'

const api = createClient({
  timeout: 5000,
  retries: 2,
})

const data = await api('/api/users').then((r) => r.json())
```

### **With Error Handling**

```typescript
try {
  const response = await api('/api/data')
  return await response.json()
} catch (err) {
  if (err instanceof TimeoutError) {
    // Handle timeout
  } else if (err instanceof RetryLimitError) {
    // Handle retry exhaustion
  }
  throw err
}
```

### **With Authentication**

```typescript
const api = createClient({
  hooks: {
    transformRequest: async (req) => {
      return new Request(req, {
        headers: {
          ...Object.fromEntries(req.headers),
          Authorization: `Bearer ${getToken()}`,
        },
      })
    },
  },
})
```

## **Contributing**

Found an issue or want to improve the documentation?

- **Issues**: [GitHub Issues](https://github.com/fetch-kit/ffetch/issues)
- **Pull Requests**: [GitHub PRs](https://github.com/fetch-kit/ffetch/pulls)
- **Discussions**: [GitHub Discussions](https://github.com/fetch-kit/ffetch/discussions)

## **License**

MIT © 2025 gkoos
