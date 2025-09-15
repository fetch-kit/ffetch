# Migration Guide: From Native Fetch to ffetch

This guide helps you migrate from native `fetch()` to `ffetch` while understanding the differences and new capabilities.

## Quick Start Migration

### Basic Replacement

```typescript
// Before: Native fetch
const response = await fetch('https://api.example.com/data')
const data = await response.json()

// After: ffetch
import createClient from '@gkoos/ffetch'
const client = createClient()
const response = await client('https://api.example.com/data')
const data = await response.json()
```

### With Options

```typescript
// Before: Native fetch with options
const response = await fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John' }),
  signal: abortController.signal,
})

// After: ffetch (same options + new ones)
const response = await client('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John' }),
  signal: abortController.signal,
  // New ffetch-specific options
  timeout: 5000,
  retries: 3,
})
```

## Key Compatibility Points

### ✅ **Fully Compatible & Pluggable**

ffetch can now be used as a drop-in wrapper for custom fetch implementations. This makes migration easier for SSR/metaframeworks (SvelteKit, Next.js, Nuxt, etc.) and for environments where you need to provide your own fetch (e.g., node-fetch, undici, framework-provided fetch).

Simply pass your custom fetch implementation using the `fetchHandler` option:

```typescript
import createClient from '@gkoos/ffetch'
import fetch from 'node-fetch'

const client = createClient({ fetchHandler: fetch })
```

These work exactly the same as native fetch:

```typescript
// HTTP status handling - identical to native fetch
const response = await client('https://api.example.com/data')
if (!response.ok) {
  console.log('HTTP error:', response.status) // Same as native fetch
}

// Request/Response objects - same Web API objects
const request = new Request('https://api.example.com')
const response = await client(request)

// AbortSignal - same Web API
const controller = new AbortController()
const response = await client('/api/data', { signal: controller.signal })
```

### 🔄 **Enhanced but Compatible**

These work the same but with additional features:

```typescript
// RequestInit extended with new options
const response = await client('/api/data', {
  // All native fetch options work
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },

  // Plus new ffetch options
  timeout: 10000,
  retries: 2,
  retryDelay: 1000,
})
```

## Error Handling Migration

### Native Fetch Error Patterns

```typescript
// Native fetch error handling
try {
  const response = await fetch('https://api.example.com/data')

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
} catch (err) {
  if (err instanceof TypeError) {
    console.log('Network error:', err.message)
  } else if (err instanceof DOMException && err.name === 'AbortError') {
    console.log('Request was aborted')
  } else {
    console.log('Other error:', err)
  }
}
```

### ffetch Enhanced Error Handling

```typescript
import createClient, {
  NetworkError,
  AbortError,
  TimeoutError,
  RetryLimitError,
} from '@gkoos/ffetch'

const client = createClient({ timeout: 5000, retries: 2 })

try {
  const response = await client('https://api.example.com/data')

  // HTTP error handling - same as native fetch
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
} catch (err) {
  // Enhanced error types with original errors preserved in .cause
  if (err instanceof NetworkError) {
    console.log('Network error:', err.message)
    console.log('Original error:', err.cause) // Access native TypeError
  } else if (err instanceof AbortError) {
    console.log('Request was aborted')
    console.log('Original error:', err.cause) // Access native DOMException
  } else if (err instanceof TimeoutError) {
    console.log('Request timed out') // New: automatic timeout handling
  } else if (err instanceof RetryLimitError) {
    console.log('Failed after retries') // New: retry exhaustion
  }
}
```

### Accessing Original Native Errors

```typescript
// If you need the exact native error for compatibility
try {
  await client('/api/data')
} catch (err) {
  if (err instanceof NetworkError) {
    const originalTypeError = err.cause // This is the native TypeError
    // Handle as you would with native fetch
  }

  if (err instanceof AbortError) {
    const originalDOMException = err.cause // This is the native DOMException
    // originalDOMException.name === 'AbortError'
  }
}
```

## New Capabilities

### Automatic Retries

```typescript
// Native fetch - manual retry logic needed
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options)
      if (response.ok || i === retries) return response
    } catch (err) {
      if (i === retries) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, i)))
  }
}

// ffetch - built-in retries
const client = createClient({
  retries: 3,
  retryDelay: ({ attempt }) => 1000 * Math.pow(2, attempt),
})
const response = await client('/api/data') // Automatically retries
```

### Automatic Timeouts

```typescript
// Native fetch - manual timeout needed
function fetchWithTimeout(url, options, timeout = 5000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId))
}

// ffetch - built-in timeout
const client = createClient({ timeout: 5000 })
const response = await client('/api/data') // Automatically times out
```

### Circuit Breaker

```typescript
// Native fetch - no built-in circuit breaker
// You'd need to implement this manually

// ffetch - built-in circuit breaker
const client = createClient({
  circuit: {
    threshold: 5, // Open after 5 failures
    reset: 30000, // Try again after 30 seconds
  },
})
const response = await client('/api/data') // Automatically circuit breaks
```

## Migration Strategy

### 1. **Drop-in Replacement**

Start by replacing `fetch` calls with minimal changes:

```typescript
// Step 1: Basic replacement
- const response = await fetch(url, options)
+ const client = createClient()
+ const response = await client(url, options)
```

### 2. **Add Basic Enhancements**

```typescript
// Step 2: Add timeout and retries
const client = createClient({
  timeout: 10000,
  retries: 2,
})
```

### 3. **Enhance Error Handling**

```typescript
// Step 3: Use enhanced error types
import { NetworkError, TimeoutError, RetryLimitError } from '@gkoos/ffetch'

try {
  const response = await client('/api/data')
} catch (err) {
  if (err instanceof NetworkError) {
    // Handle network issues
  } else if (err instanceof TimeoutError) {
    // Handle timeouts
  }
  // Original error always available in err.cause
}
```

### 4. **Add Advanced Features**

```typescript
// Step 4: Add hooks, circuit breaker, etc.
const client = createClient({
  timeout: 10000,
  retries: 3,
  circuit: { threshold: 5, reset: 30000 },
  hooks: {
    before: (req) => console.log('Making request to:', req.url),
    onError: (req, err) => console.log('Request failed:', err.message),
  },
})
```

## Common Gotchas

### 1. **Signal Combination**

```typescript
// Native fetch - one signal only
const controller = new AbortController()
const response = await fetch(url, { signal: controller.signal })

// ffetch - combines multiple signals automatically
const controller = new AbortController()
const response = await client(url, {
  signal: controller.signal, // User signal
  timeout: 5000, // Creates timeout signal
  // Both signals are automatically combined
})
```

### 2. **Error Instance Checks**

```typescript
// If you have existing error handling that checks for specific types
try {
  await client('/api/data')
} catch (err) {
  // OLD: This won't work anymore
  if (err instanceof TypeError) {
    /* ... */
  }

  // NEW: Check ffetch error types first, then check .cause
  if (err instanceof NetworkError && err.cause instanceof TypeError) {
    // Handle network error (original TypeError in err.cause)
  }
}
```

### 3. **Pending Requests**

```typescript
// Native fetch - no built-in way to track pending requests
// You'd need to manage this manually

// ffetch - built-in pending request tracking
const client = createClient()
client('/api/data')
client('/api/other')

console.log('Pending requests:', client.pendingRequests.length) // 2

// Access individual pending requests
client.pendingRequests[0].controller.abort() // Abort first request

// Abort all pending requests (new in v3)
client.abortAll() // Instantly aborts all active requests
```

## TypeScript Migration

### Type Definitions

```typescript
// Native fetch types
function myFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response>

// ffetch types - extends RequestInit
import { FFetch, FFetchRequestInit } from '@gkoos/ffetch'

function myFFetch(
  input: RequestInfo | URL,
  init?: FFetchRequestInit
): Promise<Response>

// FFetchRequestInit extends RequestInit with additional options
const options: FFetchRequestInit = {
  method: 'POST', // Standard RequestInit
  headers: {}, // Standard RequestInit
  timeout: 5000, // ffetch extension
  retries: 3, // ffetch extension
}

// PendingRequest type changed in v3:
// Old: { promise, request, signal }
// New: { promise, request, controller }
```

## Performance Considerations

### Bundle Size

```typescript
// Native fetch - 0 bytes (built into platform)
// ffetch - ~3KB gzipped additional size

// Tree-shaking: Only import what you need
import createClient from '@gkoos/ffetch' // Full library
import { NetworkError, TimeoutError } from '@gkoos/ffetch' // Just error types
```

### Memory Usage

```typescript
// ffetch keeps track of pending requests
const client = createClient()

// Each request adds to pendingRequests array until completion
const response = await client('/api/data') // Automatically removed when done

// For long-running apps, this is handled automatically
// No memory leaks as requests are cleaned up on completion
```

## Best Practices for Migration

1. **Start Simple**: Begin with basic timeout and retry configuration
2. **Gradual Enhancement**: Add advanced features incrementally
3. **Test Error Handling**: Verify your error handling works with new error types
4. **Monitor Performance**: Check that enhanced features don't impact performance
5. **Leverage TypeScript**: Use type definitions for better development experience

## Rollback Strategy

If you need to rollback to native fetch:

```typescript
// Create a compatibility wrapper
function createFetchClient() {
  return fetch.bind(window) // or global fetch
}

// Replace ffetch usage with minimal changes
- const client = createClient()
+ const client = createFetchClient()

// Most code will work unchanged due to ffetch's fetch compatibility
```
