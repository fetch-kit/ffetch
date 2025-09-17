# Usage Examples

Real-world examples and patterns for using `@gkoos/ffetch` in different scenarios.

## Basic Usage Patterns

### Checking Circuit State Before Request

You can inspect the circuit breaker state at runtime using `client.circuitOpen` to avoid making requests when the circuit is open:

```typescript
import createClient from '@gkoos/ffetch'

const client = createClient({
  circuit: { threshold: 5, reset: 30000 },
})

if (client.circuitOpen) {
  console.warn('Service is unavailable (circuit open). Skipping request.')
} else {
  const response = await client('https://api.example.com/data')
  const data = await response.json()
}
```

// If the client is not configured with a circuit breaker, client.circuitOpen will always be false.

### Simple HTTP Client

```typescript
import createClient from '@gkoos/ffetch'

const api = createClient({
  timeout: 10000,
  retries: 2,
})

// GET request
const users = await api('https://api.example.com/users').then((r) => r.json())

// POST request
const newUser = await api('https://api.example.com/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John', email: 'john@example.com' }),
}).then((r) => r.json())
```

### REST API Client

```typescript
import createClient, { type FFetch } from '@gkoos/ffetch'

class ApiClient {
  private client: FFetch
  private baseUrl: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.client = createClient({
      timeout: 15000,
      retries: 3,
      hooks: {
        transformRequest: async (req) => {
          // Build full URL from base + path
          const fullUrl = new URL(req.url, this.baseUrl).toString()

          return new Request(fullUrl, {
            method: req.method,
            headers: {
              ...Object.fromEntries(req.headers),
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: req.body,
            signal: req.signal,
          })
        },
      },
    })
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.client(path)
    return response.json()
  }

  async post<T>(path: string, data: any): Promise<T> {
    const response = await this.client(path, {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return response.json()
  }

  async put<T>(path: string, data: any): Promise<T> {
    const response = await this.client(path, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
    return response.json()
  }

  async delete(path: string): Promise<void> {
    await this.client(path, { method: 'DELETE' })
  }
}

// Usage
const api = new ApiClient('https://api.example.com/v1', process.env.API_KEY!)
const users = await api.get<User[]>('/users')
const newUser = await api.post<User>('/users', { name: 'John' })
```

## Custom Fetch Usage

### Using ffetch with a Custom Fetch (e.g., node-fetch)

```typescript
import createClient from '@gkoos/ffetch'
import fetch from 'node-fetch'

const client = createClient({ fetchHandler: fetch })
const response = await client('https://api.example.com/data')
const data = await response.json()
```

### Injecting a Mock Fetch for Unit Tests

```typescript
import createClient from '@gkoos/ffetch'

function mockFetch(url, options) {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, url }), { status: 200 })
  )
}

const client = createClient({ fetchHandler: mockFetch })
const response = await client('https://api.example.com/test')
const data = await response.json()
// data: { ok: true, url: 'https://api.example.com/test' }
```

## Advanced Patterns

### Microservices Client

```typescript
import createClient, { type FFetch } from '@gkoos/ffetch'

interface ServiceConfig {
  baseUrl: string
  timeout?: number
  retries?: number
  circuitBreaker?: { threshold: number; reset: number }
}

class MicroserviceClient {
  private clients = new Map<string, FFetch>()

  constructor(private services: Record<string, ServiceConfig>) {}

  private getClient(serviceName: string): FFetch {
    if (!this.clients.has(serviceName)) {
      const config = this.services[serviceName]
      if (!config) {
        throw new Error(`Service ${serviceName} not configured`)
      }

      const client = createClient({
        timeout: config.timeout || 5000,
        retries: config.retries || 2,
        circuit: config.circuitBreaker,
        hooks: {
          transformRequest: async (req) => {
            // Properly construct full URL
            const fullUrl = new URL(req.url, config.baseUrl).toString()
            return new Request(fullUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body,
              signal: req.signal,
            })
          },
          before: async (req) => {
            console.log(`[${serviceName}] →`, req.method, req.url)
          },
          after: async (req, res) => {
            console.log(`[${serviceName}] ←`, res.status)
          },
          onError: async (req, err) => {
            console.error(`[${serviceName}] ✗`, err.message)
          },
        },
      })

      this.clients.set(serviceName, client)
    }

    return this.clients.get(serviceName)!
  }

  async call(serviceName: string, path: string, options?: RequestInit) {
    const client = this.getClient(serviceName)
    return client(path, options)
  }

  // Service-specific methods
  async getUser(id: string) {
    return this.call('users', `/users/${id}`).then((r) => r.json())
  }

  async createOrder(order: any) {
    return this.call('orders', '/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    }).then((r) => r.json())
  }

  async processPayment(payment: any) {
    return this.call('payments', '/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payment),
    }).then((r) => r.json())
  }
}

// Configuration
const client = new MicroserviceClient({
  users: {
    baseUrl: 'https://users.service.com/api',
    timeout: 3000,
    retries: 2,
  },
  orders: {
    baseUrl: 'https://orders.service.com/api',
    timeout: 5000,
    retries: 3,
    circuitBreaker: { threshold: 5, reset: 30000 },
  },
  payments: {
    baseUrl: 'https://payments.service.com/api',
    timeout: 10000,
    retries: 1,
    circuitBreaker: { threshold: 3, reset: 60000 },
  },
})
```

### GraphQL Client

```typescript
import createClient, { type FFetch } from '@gkoos/ffetch'

class GraphQLClient {
  private client: FFetch

  constructor(
    private endpoint: string,
    headers: Record<string, string> = {}
  ) {
    this.client = createClient({
      timeout: 30000,
      retries: 2,
      hooks: {
        transformRequest: async (req) => {
          // Always POST to the GraphQL endpoint
          return new Request(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...headers,
              ...Object.fromEntries(req.headers),
            },
            body: req.body,
            signal: req.signal,
          })
        },
        transformResponse: async (res) => {
          const data = await res.json()
          if (data.errors && data.errors.length > 0) {
            throw new GraphQLError(data.errors, data.data)
          }
          // Return a new response with just the data
          return new Response(JSON.stringify(data.data), {
            status: res.status,
            headers: res.headers,
          })
        },
      },
    })
  }

  async query<T = any>(
    query: string,
    variables?: Record<string, any>
  ): Promise<T> {
    const response = await this.client('', {
      body: JSON.stringify({ query, variables }),
    })
    return response.json()
  }

  async mutate<T = any>(
    mutation: string,
    variables?: Record<string, any>
  ): Promise<T> {
    return this.query<T>(mutation, variables)
  }
}

class GraphQLError extends Error {
  constructor(
    public errors: any[],
    public data: any
  ) {
    super(`GraphQL Error: ${errors.map((e) => e.message).join(', ')}`)
  }
}

// Usage
const gql = new GraphQLClient('https://api.example.com/graphql', {
  Authorization: 'Bearer ' + token,
})

const user = await gql.query(
  `
  query GetUser($id: ID!) {
    user(id: $id) {
      id
      name
      email
    }
  }
`,
  { id: '123' }
)
```

### File Upload Client

```typescript
import createClient, { type FFetch } from '@gkoos/ffetch'

class FileUploadClient {
  private client: FFetch

  constructor() {
    this.client = createClient({
      timeout: 300000, // 5 minutes for uploads
      retries: 1, // Limited retries for file uploads
    })
  }

  async uploadFile(file: File, url: string): Promise<any> {
    const formData = new FormData()
    formData.append('file', file)

    const response = await this.client(url, {
      method: 'POST',
      body: formData,
      hooks: {
        before: async (req) => {
          console.log(
            `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
          )
        },
        after: async (req, res) => {
          console.log(`Upload complete: ${res.status}`)
        },
        onError: async (req, err) => {
          console.error(`Upload failed: ${err.message}`)
        },
      },
    })

    return response.json()
  }

  async uploadWithMetadata(
    file: File,
    url: string,
    metadata: Record<string, string>
  ): Promise<any> {
    const formData = new FormData()
    formData.append('file', file)

    // Add metadata fields
    Object.entries(metadata).forEach(([key, value]) => {
      formData.append(key, value)
    })

    const response = await this.client(url, {
      method: 'POST',
      body: formData,
    })

    return response.json()
  }

  async uploadMultiple(files: File[], url: string): Promise<any[]> {
    // Upload files in parallel with concurrency limit
    const concurrency = 3
    const results: any[] = []

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency)
      const batchPromises = batch.map((file) =>
        this.uploadFile(file, url).catch((err) => ({
          error: err.message,
          file: file.name,
        }))
      )
      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)
    }

    return results
  }
}

// Usage
const uploader = new FileUploadClient()

// Single file upload
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const file = fileInput.files![0]
const result = await uploader.uploadFile(file, '/api/upload')

// Multiple file upload with metadata
const files = Array.from(fileInput.files!)
const results = await uploader.uploadMultiple(files, '/api/upload')
```

### No Timeout for Long Operations

For very large uploads, streaming operations, or long-running requests where you don't want any timeout:

```typescript
import createClient from '@gkoos/ffetch'

// Client with no timeout - useful for streaming or very large uploads
const streamingClient = createClient({
  timeout: 0, // Disables timeout entirely
  retries: 0, // Usually don't retry streaming operations
})

// Example: Stream large file upload
async function uploadLargeFile(file: File) {
  const response = await streamingClient('/api/upload/stream', {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type,
      'Content-Length': file.size.toString(),
    },
  })

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`)
  }

  return response.json()
}

// Or override timeout per request
const client = createClient({ timeout: 5000 }) // Default 5s timeout

async function normalRequest() {
  return client('/api/quick') // Uses 5s timeout
}

async function longRequest() {
  return client('/api/long-process', {
    timeout: 0, // No timeout for this specific request
  })
}
```

### Real-time Data Polling

```typescript
import createClient, { AbortError, type FFetch } from '@gkoos/ffetch'

class DataPoller {
  private client: FFetch
  private intervalId?: number
  private abortController?: AbortController

  constructor() {
    this.client = createClient({
      timeout: 5000,
      retries: 2,
    })
  }

  startPolling(
    url: string,
    interval: number,
    onData: (data: any) => void,
    onError?: (error: Error) => void
  ) {
    this.stopPolling()
    this.abortController = new AbortController()

    const poll = async () => {
      try {
        const response = await this.client(url, {
          signal: this.abortController?.signal,
        })
        const data = await response.json()
        onData(data)
      } catch (error) {
        if (error instanceof AbortError) {
          return // Polling was stopped
        }
        onError?.(error as Error)
      }
    }

    // Poll immediately, then on interval
    poll()
    this.intervalId = window.setInterval(poll, interval)
  }

  stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = undefined
    }
  }
}

// Usage
const poller = new DataPoller()
poller.startPolling(
  'https://api.example.com/status',
  5000, // Poll every 5 seconds
  (data) => console.log('Status update:', data),
  (error) => console.error('Polling error:', error)
)

// Stop polling when component unmounts or page unloads
window.addEventListener('beforeunload', () => poller.stopPolling())
```

### Caching with TTL

```typescript
import createClient, { type FFetch } from '@gkoos/ffetch'

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

class CachedApiClient {
  private client: FFetch
  private cache = new Map<string, CacheEntry<any>>()

  constructor() {
    this.client = createClient({
      timeout: 10000,
      retries: 2,
    })
  }

  async get<T>(url: string, ttl: number = 60000): Promise<T> {
    const cacheKey = url
    const cached = this.cache.get(cacheKey)

    // Check if cache is valid
    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      console.log('Cache hit:', url)
      return cached.data
    }

    console.log('Cache miss:', url)
    const response = await this.client(url)
    const data = await response.json()

    // Store in cache
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      ttl,
    })

    return data
  }

  async post<T>(url: string, body: any, cacheTtl?: number): Promise<T> {
    const response = await this.client(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json()

    // Optionally cache POST responses
    if (cacheTtl) {
      this.cache.set(`${url}:${JSON.stringify(body)}`, {
        data,
        timestamp: Date.now(),
        ttl: cacheTtl,
      })
    }

    return data
  }

  invalidate(pattern?: string) {
    if (pattern) {
      const regex = new RegExp(pattern)
      for (const [key] of this.cache) {
        if (regex.test(key)) {
          this.cache.delete(key)
        }
      }
    } else {
      this.cache.clear()
    }
  }

  // Clean expired entries
  cleanup() {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp >= entry.ttl) {
        this.cache.delete(key)
      }
    }
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    }
  }
}

// Usage with automatic cleanup
const cachedClient = new CachedApiClient()
setInterval(() => cachedClient.cleanup(), 60000)

// Examples
const config = await cachedClient.get('/api/config', 300000) // Cache for 5 minutes
const users = await cachedClient.get('/api/users', 60000) // Cache for 1 minute
const result = await cachedClient.post('/api/search', { query: 'test' }, 30000) // Cache search results
```

## Error Handling Patterns

### Graceful Degradation

```typescript
class ResilientApiClient {
  private client: FFetch
  private fallbackData: Record<string, any> = {}

  constructor() {
    this.client = createClient({
      timeout: 5000,
      retries: 3,
      circuit: { threshold: 5, reset: 30000 },
    })
  }

  async getWithFallback<T>(url: string, fallback: T): Promise<T> {
    try {
      const response = await this.client(url)
      const data = await response.json()

      // Cache successful response as fallback for next time
      this.fallbackData[url] = data
      return data
    } catch (error) {
      console.warn(`API call failed, using fallback:`, error.message)

      // Use cached data if available
      if (this.fallbackData[url]) {
        return this.fallbackData[url]
      }

      // Use provided fallback
      return fallback
    }
  }
}

// Usage
const client = new ResilientApiClient()
const config = await client.getWithFallback('/api/config', {
  theme: 'light',
  features: ['basic'],
})
```

### Retry with Different Strategies

```typescript
const strategicClient = createClient({
  retries: 3,
  shouldRetry: ({ attempt, response, error }) => {
    // Don't retry client errors (4xx)
    if (response && response.status >= 400 && response.status < 500) {
      return false
    }

    // Don't retry after 3 attempts
    if (attempt > 3) {
      return false
    }

    // Don't retry user aborts
    if (error instanceof AbortError) {
      return false
    }

    return true
  },
  retryDelay: ({ attempt, response }) => {
    // Exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt - 1) * 1000
    const jitter = Math.random() * 1000

    // Longer delay for rate limiting
    if (response?.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      if (retryAfter) {
        return parseInt(retryAfter) * 1000
      }
      return baseDelay * 2
    }

    return baseDelay + jitter
  },
})
```
