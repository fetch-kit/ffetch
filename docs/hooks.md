# Hooks & Request/Response Transformation

Hooks allow you to observe, log, or modify the request/response lifecycle. All hooks are optional and can be set globally or per-request.

## Lifecycle Hooks

### Available Hooks

- `before(req)`: Called before each request is sent
- `after(req, res)`: Called after a successful response
- `onError(req, err)`: Called when a request fails with any error
- `onRetry(req, attempt, err, res)`: Called before each retry attempt
- `onTimeout(req)`: Called when a request times out
- `onAbort(req)`: Called when a request is aborted by the user
- `onCircuitOpen(req)`: Called when the circuit breaker is open and a request is blocked
- `onComplete(req, res, err)`: Called after every request, whether it succeeded or failed

### Basic Hooks Example

```typescript
const client = createClient({
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

## Request/Response Transformation

Transform requests and responses to add authentication, modify headers, or process data.

### Transform Request

```typescript
const client = createClient({
  hooks: {
    transformRequest: async (req) => {
      // Add authentication header
      return new Request(req, {
        headers: {
          ...Object.fromEntries(req.headers),
          Authorization: `Bearer ${getToken()}`,
          'X-API-Key': 'secret-key',
        },
      })
    },
  },
})
```

### Transform Response

```typescript
const client = createClient({
  hooks: {
    transformResponse: async (res, req) => {
      // Automatically parse JSON and add metadata
      const data = await res.json()

      return new Response(
        JSON.stringify({
          data,
          meta: {
            url: req.url,
            timestamp: new Date().toISOString(),
            requestId: res.headers.get('x-request-id'),
          },
        }),
        {
          status: res.status,
          headers: res.headers,
        }
      )
    },
  },
})
```

## Common Use Cases

### 1. Authentication

```typescript
const apiClient = createClient({
  hooks: {
    transformRequest: async (req) => {
      const token = await getAuthToken()
      return new Request(req, {
        headers: {
          ...Object.fromEntries(req.headers),
          Authorization: `Bearer ${token}`,
        },
      })
    },

    after: async (req, res) => {
      // Handle 401 responses by refreshing token
      if (res.status === 401) {
        await refreshAuthToken()
        // Note: You might want to retry the request here
        // or handle this in your application logic
      }
    },

    onError: async (req, err) => {
      console.error('Request failed:', err.message)
    },
  },
})
```

### 2. Logging and Metrics

```typescript
const logger = createLogger('api-client')
let requestCounter = 0

const client = createClient({
  hooks: {
    before: async (req) => {
      const requestId = ++requestCounter
      logger.info(`[${requestId}] → ${req.method} ${req.url}`)
      req.headers.set('X-Request-ID', requestId.toString())
    },

    after: async (req, res) => {
      const requestId = req.headers.get('X-Request-ID')
      const duration = res.headers.get('X-Response-Time') || 'unknown'
      logger.info(`[${requestId}] ← ${res.status} (${duration}ms)`)
    },

    onError: async (req, err) => {
      const requestId = req.headers.get('X-Request-ID')
      logger.error(`[${requestId}] ✗ ${err.constructor.name}: ${err.message}`)
    },

    onComplete: async (req, res, err) => {
      // Send metrics to monitoring system
      trackApiCall({
        url: req.url,
        method: req.method,
        status: res?.status,
        error: err?.constructor.name,
        timestamp: Date.now(),
      })
    },
  },
})
```

### 3. Request/Response Caching

```typescript
const cache = new Map()

const client = createClient({
  hooks: {
    before: async (req) => {
      // Check cache for GET requests
      if (req.method === 'GET') {
        const cached = cache.get(req.url)
        if (cached && Date.now() - cached.timestamp < 60000) {
          // 1 minute cache
          throw new CacheHitError(cached.response)
        }
      }
    },

    after: async (req, res) => {
      // Cache successful GET responses
      if (req.method === 'GET' && res.ok) {
        cache.set(req.url, {
          response: res.clone(),
          timestamp: Date.now(),
        })
      }
    },
  },
})
```

### 4. Request Sanitization

```typescript
const client = createClient({
  hooks: {
    transformRequest: async (req) => {
      // Remove sensitive headers in production
      if (process.env.NODE_ENV === 'production') {
        const headers = new Headers(req.headers)
        headers.delete('X-Debug-Token')
        headers.delete('X-Internal-User-ID')

        return new Request(req, { headers })
      }
      return req
    },

    transformResponse: async (res, req) => {
      // Remove sensitive data from responses
      if (res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json()

        // Remove internal fields
        delete data._internal
        delete data.debugInfo

        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: res.headers,
        })
      }
      return res
    },
  },
})
```

### 5. Rate Limiting and Backpressure

```typescript
const rateLimiter = new Map()

const client = createClient({
  hooks: {
    before: async (req) => {
      const host = new URL(req.url).host
      const now = Date.now()
      const requests = rateLimiter.get(host) || []

      // Remove old requests (older than 1 minute)
      const recentRequests = requests.filter((time) => now - time < 60000)

      // Check if we're over the limit (100 requests per minute)
      if (recentRequests.length >= 100) {
        throw new RateLimitError(`Rate limit exceeded for ${host}`)
      }

      // Add this request
      recentRequests.push(now)
      rateLimiter.set(host, recentRequests)
    },
  },
})
```

### 6. Request Retry with Custom Logic

```typescript
const client = createClient({
  retries: 3,
  hooks: {
    onRetry: async (req, attempt, err, res) => {
      console.log(`Retry ${attempt - 1}/3 for ${req.url}`)

      // Add exponential backoff delay
      const delay = Math.min(1000 * Math.pow(2, attempt - 2), 10000)
      console.log(`Waiting ${delay}ms before retry...`)
      await new Promise((resolve) => setTimeout(resolve, delay))

      // Modify request for retry (e.g., refresh auth token)
      if (res?.status === 401) {
        await refreshAuthToken()
      }
    },
  },
})
```

## Circuit Breaker Hooks

### onCircuitOpen

Called when the circuit transitions to open after consecutive failures. Receives the request that triggered the open event.

Signature: `(req: Request) => void | Promise<void>`

### onCircuitClose

Called when the circuit transitions to closed after a successful request. Receives the request that closed the circuit.

Signature: `(req: Request) => void | Promise<void>`

### Example

```js
const client = createClient({
  circuit: { threshold: 2, reset: 1000 },
  hooks: {
    onCircuitOpen: (req) => console.warn('Circuit opened due to:', req.url),
    onCircuitClose: (req) => console.info('Circuit closed after:', req.url),
  },
})
```

## Hook Execution Order

When a request is made, hooks execute in this order:

1. `transformRequest` - Modify the outgoing request
2. `before` - Called just before sending
3. **Request is sent**
4. `transformResponse` - Modify the incoming response (if successful)
5. `after` - Called after successful response
6. `onComplete` - Always called last

If an error occurs or retry is needed:

1. `onError` - Called on any error
2. `onRetry` - Called before retry attempts
3. `onTimeout` - Called on timeout errors
4. `onAbort` - Called on abort errors
5. `onCircuitOpen` - Called when circuit breaker transitions to open
6. `onCircuitClose` - Called when circuit breaker transitions to closed
7. `onComplete` - Always called last

## Per-Request Hooks

You can override hooks for individual requests:

```typescript
// Global client with basic logging
const client = createClient({
  hooks: {
    before: (req) => console.log('Request:', req.url),
  },
})

// Override hooks for a specific request
await client('https://api.example.com/special', {
  hooks: {
    before: (req) => console.log('Special request:', req.url),
    after: (req, res) => console.log('Special response:', res.status),
  },
})
```
