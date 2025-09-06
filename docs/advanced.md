# Advanced Features

## Per-request Overrides

You can override any client option on a per-request basis by passing it in the `init` parameter:

```typescript
const client = createClient({ timeout: 5000, retries: 2 })

// Override timeout and retries for this request only
await client('https://api.example.com/v1/users', {
  timeout: 1000, // 1s timeout for this request
  retries: 5, // up to 5 retries for this request
})

// Use a custom retry delay function for a single request
await client('https://api.example.com/v1/data', {
  retryDelay: ({ attempt }) => 100 * attempt, // linear backoff for this request
})

// Override hooks for a single request
await client('https://api.example.com/v1/metrics', {
  hooks: {
    before: (req) => console.log('Single request:', req.url),
  },
})
```

## Pending Requests Monitoring

You can access and monitor all active requests through the `pendingRequests` property on the client instance:

```typescript
const client = createClient()

// Start some requests
const promise1 = client('https://api.example.com/users')
const promise2 = client('https://api.example.com/posts')

// Monitor active requests
console.log(`${client.pendingRequests.length} requests in flight`)

client.pendingRequests.forEach((pending) => {
  console.log({
    url: pending.request.url,
    method: pending.request.method,
    isAborted: pending.signal.aborted,
  })
})
```

### Use Cases for Pending Requests

#### 1. Abort All Pending Requests

```typescript
// Example: Abort all pending requests on page unload
window.addEventListener('beforeunload', () => {
  // Note: To abort, you need to use the original AbortController
  // pending.signal is read-only, but you can check its state
})
```

#### 2. Wait for All Requests to Complete

```typescript
// Example: Wait for all pending requests to complete
await Promise.allSettled(
  client.pendingRequests.map((pending) => pending.promise)
)
```

#### 3. Request Monitoring Dashboard

```typescript
// Example: Real-time monitoring
setInterval(() => {
  console.log(
    'Active requests:',
    client.pendingRequests.map((p) => ({
      url: p.request.url,
      method: p.request.method,
      aborted: p.signal.aborted,
    }))
  )
}, 1000)
```

### Important Notes

- Each pending request object contains:
  - `promise` - The Promise<Response> for the request
  - `request` - The Request object with URL, headers, method, etc.
  - `signal` - The AbortSignal being used (read-only)
- Requests are automatically added when they start and removed when they complete (success or failure)
- Each client instance maintains its own separate `pendingRequests` array

## Retry Strategies and Backoff

### Custom Retry Delay

You can provide a function for `retryDelay` that receives a context object:

```typescript
const client = createClient({
  retryDelay: ({ attempt, request, response, error }) => {
    // attempt: number (starts at 2 for first retry)
    // request: Request
    // response: Response | undefined
    // error: unknown

    // Linear backoff
    return 100 * attempt

    // Exponential backoff with cap
    return Math.min(2 ** attempt * 1000, 30000)

    // Custom logic based on response
    if (response?.status === 429) {
      // Longer delay for rate limiting
      return 5000
    }
    return 1000
  },
})
```

### Custom Retry Logic

You can provide a function for `shouldRetry` that receives the same context object:

```typescript
const client = createClient({
  shouldRetry: ({ attempt, request, response, error }) => {
    // Don't retry more than 3 times
    if (attempt > 3) return false

    // Retry only on 503 Service Unavailable
    return response?.status === 503

    // Custom logic based on error type
    if (error instanceof NetworkError) return true
    if (error instanceof TimeoutError) return attempt <= 2

    return false
  },
})
```

### Retry-After Header Support

By default, if the server responds with a `Retry-After` header (either in seconds or as a date), `ffetch` will honor it and use it as the delay before the next retry. This behavior is built into the default retry logic and can be customized via the `retryDelay` option.

```typescript
// The server sends: Retry-After: 30
// ffetch will wait 30 seconds before retrying

// The server sends: Retry-After: Wed, 21 Oct 2015 07:28:00 GMT
// ffetch will wait until that date/time before retrying
```

## Circuit Breaker Pattern

The circuit breaker pattern protects your service from repeated failures by temporarily blocking requests after a threshold of consecutive errors. This helps prevent cascading failures and allows your system to recover gracefully.

### How it Works

- When the number of consecutive failures reaches the `threshold`, the circuit "opens" and all further requests fail fast with a `CircuitOpenError`
- After the `reset` period (in milliseconds), the circuit "closes" and requests are allowed again
- If a request succeeds, the failure count resets

### Configuration

```typescript
const client = createClient({
  retries: 0, // let circuit breaker handle failures
  circuit: {
    threshold: 5, // Open after 5 consecutive failures
    reset: 30_000, // Close after 30 seconds
  },
})
```

### Parameters

- `threshold`: _(number)_ — How many consecutive failures will "trip" (open) the circuit. Example: `5` means after 5 failures, the circuit opens.
- `reset`: _(number, ms)_ — How long (in milliseconds) to wait before closing the circuit and allowing requests again. Example: `30_000` is 30 seconds.

### Advanced Circuit Breaker Patterns

```typescript
// Different thresholds for different endpoints
const apiClient = createClient({
  circuit: { threshold: 10, reset: 60_000 }, // More tolerant for API
})

const healthClient = createClient({
  circuit: { threshold: 3, reset: 10_000 }, // Less tolerant for health checks
})
```

## Custom Error Handling

`ffetch` throws custom error classes for robust error handling. All custom errors have a `.cause` property:

- If the error is mapped from a native error (e.g., a DOMException or TypeError from fetch), `.cause` will reference the original error
- If the error is user-initiated (e.g., user aborts a request), `.cause` will be `undefined`

### Error Types

- `TimeoutError`: The request timed out
- `AbortError`: The request was aborted by the user
- `CircuitOpenError`: The circuit breaker is open and requests are blocked
- `RetryLimitError`: The retry limit was reached and the request failed
- `NetworkError`: A network error occurred (e.g., DNS failure, offline)

**Important**: `ffetch` follows the same behavior as native `fetch()` for HTTP status codes. **HTTP errors (4xx, 5xx) do not throw exceptions** - they return Response objects normally. You must check `response.ok` or `response.status` to handle HTTP errors.

### Error Handling Example

```typescript
import createClient, {
  TimeoutError,
  AbortError,
  CircuitOpenError,
  RetryLimitError,
  NetworkError,
} from '@gkoos/ffetch'

const client = createClient({ timeout: 1000, retries: 2 })

try {
  const response = await client('https://example.com')

  // Check for HTTP errors manually (like native fetch)
  if (!response.ok) {
    console.log('HTTP error:', response.status, response.statusText)
    // Handle HTTP errors based on status code
    if (response.status === 404) {
      // Handle not found
    } else if (response.status >= 500) {
      // Handle server errors
    }
    return
  }

  // Handle successful response
  const data = await response.json()
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log('Request timed out')
    // Maybe show a user-friendly timeout message
  } else if (err instanceof AbortError) {
    console.log('Request was cancelled')
    // User cancelled, no action needed
  } else if (err instanceof CircuitOpenError) {
    console.log('Service is currently unavailable')
    // Show maintenance message
  } else if (err instanceof RetryLimitError) {
    console.log('Request failed after retries')
    // Log the underlying error: err.cause
  } else if (err instanceof NetworkError) {
    console.log('Network connectivity issue')
    // Show offline message
  } else {
    console.log('Unknown error:', err)
    // Fallback error handling
  }
}
```

### Error Context and Debugging

```typescript
// All errors provide context for debugging
catch (err) {
  if (err instanceof RetryLimitError) {
    console.log('Request failed after all retries')
    console.log('Last error was:', err.cause)
  }

  if (err instanceof TimeoutError) {
    console.log('Request timed out')
    console.log('Original cause:', err.cause)
  }

  // For HTTP errors, check the response object:
  const response = await client('https://example.com')
  if (!response.ok) {
    console.log('HTTP error:', response.status, response.statusText)
    const errorBody = await response.text()
    console.log('Error response body:', errorBody)
  }
}
```
