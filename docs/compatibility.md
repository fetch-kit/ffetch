# Browser & Node.js Compatibility

## Prerequisites

`ffetch` can work without native `AbortSignal.timeout` because it has an internal timeout fallback. Signal combination requires **`AbortSignal.any`** (native or polyfill).

## Node.js Support

### Native Support

- **Node.js v18.8.0+**: Full native support for `AbortSignal.timeout`
- **Node.js v20.6.0+**: Full native support for both `AbortSignal.timeout` and `AbortSignal.any`

### Polyfills for Older Versions

For older Node.js versions, you must install a polyfill for `AbortSignal.any`.
`AbortSignal.timeout` polyfill is optional because `ffetch` has an internal timeout fallback:

```bash
npm install abortcontroller-polyfill abort-controller-x
```

Then ensure the APIs are available globally before importing `ffetch`:

```javascript
// Optional: abortcontroller-polyfill (for native-style AbortSignal.timeout)
require('abortcontroller-polyfill/dist/polyfill-patch-fetch')

// Required when AbortSignal.any is missing
import 'abort-controller-x/polyfill'

// Now you can use ffetch
import { createClient } from '@fetchkit/ffetch'
```

### Node.js Specific Considerations

#### HTTP vs HTTPS

```javascript
// Node.js automatically handles HTTP/HTTPS protocols
const client = createClient()
await client('https://api.example.com') // Works
await client('http://localhost:3000') // Works
```

#### Custom Node Connection Agent

```javascript
import https from 'https'
import fetch from 'node-fetch'

const agent = new https.Agent({
  keepAlive: true,
  timeout: 5000,
})

// Wrap your fetch implementation and inject transport-specific options there.
const fetchWithAgent = (input, init) => fetch(input, { ...init, agent })

const client = createClient({ fetchHandler: fetchWithAgent })

await client('https://api.example.com')
```

`agent` is fetch-implementation-specific and not part of standard `RequestInit`. Prefer configuring it inside `fetchHandler`.

#### Self-signed Certificates (Development)

```javascript
// For development only - never use in production
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Better approach: configure a custom agent in fetchHandler
import https from 'https'
import fetch from 'node-fetch'

const agent = new https.Agent({
  rejectUnauthorized: false,
})

const client = createClient({
  fetchHandler: (input, init) => fetch(input, { ...init, agent }),
})

await client('https://localhost:8443')
```

## Browser Support

### Modern Browsers (Recommended)

- **Chrome 117+**: Native support for required AbortSignal APIs
- **Firefox 117+**: Native support for required AbortSignal APIs
- **Safari 17+**: Native support for required AbortSignal APIs
- **Edge 117+**: Native support for required AbortSignal APIs

### Legacy Browser Support

Older browsers can still work when `AbortSignal.any` is polyfilled. `AbortSignal.timeout` polyfill is optional:

```html
<!-- Include polyfills before your app -->
<script src="https://unpkg.com/abortcontroller-polyfill/dist/polyfill.min.js"></script>
<script src="https://unpkg.com/abort-controller-x/dist/polyfill.umd.js"></script>

<!-- Your app -->
<script type="module">
  import { createClient } from 'https://unpkg.com/@fetchkit/ffetch/dist/index.min.js'
  // ... your code
</script>
```

### Browser-Specific Features

#### Service Workers

```javascript
// Works in service workers
self.addEventListener('fetch', async (event) => {
  if (event.request.url.includes('/api/')) {
    const client = createClient({ timeout: 5000 })
    const response = await client(event.request)
    event.respondWith(response)
  }
})
```

#### Web Workers

```javascript
// Use a module worker and import the ESM build
import { createClient } from 'https://unpkg.com/@fetchkit/ffetch/dist/index.min.js'

const client = createClient()
self.postMessage(await client('/api/data').then((r) => r.json()))
```

#### CORS Handling

```javascript
const client = createClient()

// CORS requests work transparently
await client('https://api.external.com/data', {
  mode: 'cors',
  credentials: 'include',
})
```

## Environment Detection

`ffetch` automatically adapts to the environment and can wrap any fetch-compatible implementation:

```javascript
// Automatically detects environment and uses appropriate fetch implementation
// Or pass your own fetch-compatible implementation for SSR, edge, or custom environments
const client = createClient() // Uses global fetch by default

// Example: Use node-fetch, undici, or framework-provided fetch
import fetch from 'node-fetch'
const clientNode = createClient({ fetchHandler: fetch })

// Works in Node.js, browsers, workers, SSR, edge, etc.
const response = await client('https://api.example.com')
```

## Testing Environments

### Jest

```javascript
// jest.config.js
module.exports = {
  setupFilesAfterEnv: ['<rootDir>/test-setup.js'],
}

// test-setup.js
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
```

### Vitest

```javascript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom', // or 'jsdom'
    setupFiles: ['./test-setup.ts'],
  },
})

// test-setup.ts
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
```

### Playwright

```javascript
// Works out of the box in modern browsers
// For older browser testing, include polyfills in your test pages
```

## Runtime Detection and Fallbacks

### Check for Required APIs

```javascript
function checkCompatibility() {
  if (typeof AbortSignal === 'undefined') {
    throw new Error('AbortSignal not supported. Please add a polyfill.')
  }

  if (typeof AbortSignal.any !== 'function') {
    throw new Error(
      'AbortSignal.any is required for combining multiple signals. Please install a polyfill.'
    )
  }
}

// Check before creating client
checkCompatibility()
const client = createClient()
```

### Graceful Degradation

```javascript
// Fallback for environments without full AbortSignal support
const client = createClient({
  timeout: typeof AbortSignal?.timeout === 'function' ? 5000 : undefined,
  // ... other options
})
```

## CDN Usage

### ESM (Recommended)

```html
<script type="module">
  import { createClient } from 'https://unpkg.com/@fetchkit/ffetch/dist/index.min.js'

  const client = createClient()
  const data = await client('/api/data').then((r) => r.json())
</script>
```

### UMD

`ffetch` does not currently publish a UMD build. Use the ESM build shown above (or import from the package in a bundler/runtime environment).

## Framework Integration

### React

```jsx
import { useEffect, useState } from 'react'
import { createClient } from '@fetchkit/ffetch'

const client = createClient({ timeout: 5000 })

function DataComponent() {
  const [data, setData] = useState(null)

  useEffect(() => {
    const abortController = new AbortController()

    client('/api/data', { signal: abortController.signal })
      .then((r) => r.json())
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(err)
        }
      })

    return () => abortController.abort()
  }, [])

  return <div>{data ? JSON.stringify(data) : 'Loading...'}</div>
}
```

### Vue

```vue
<template>
  <div>{{ data || 'Loading...' }}</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { createClient } from '@fetchkit/ffetch'

const client = createClient({ timeout: 5000 })
const data = ref(null)
let abortController

onMounted(async () => {
  abortController = new AbortController()

  try {
    const response = await client('/api/data', {
      signal: abortController.signal,
    })
    data.value = await response.json()
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err)
    }
  }
})

onUnmounted(() => {
  abortController?.abort()
})
</script>
```

### Svelte

```svelte
<script>
  import { onMount, onDestroy } from 'svelte'
  import { createClient } from '@fetchkit/ffetch'

  const client = createClient({ timeout: 5000 })
  let data = null
  let abortController

  onMount(async () => {
    abortController = new AbortController()

    try {
      const response = await client('/api/data', {
        signal: abortController.signal
      })
      data = await response.json()
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err)
      }
    }
  })

  onDestroy(() => {
    abortController?.abort()
  })
</script>

<div>{data ? JSON.stringify(data) : 'Loading...'}</div>
```

### SSR Frameworks: SvelteKit, Next.js, Nuxt

For SvelteKit, Next.js, and Nuxt, it is recommended to pass the fetch instance provided by the framework in your handler or context for SSR-safe behavior. The parameter name may vary (often `fetch`, but check your framework docs).

**SvelteKit example:**

```typescript
// In load functions, actions, or endpoints, use the provided fetch
export async function load({ fetch }) {
  const client = createClient({ fetchHandler: fetch })
  // Use client for SSR-safe requests
}

// In endpoints
export async function GET({ fetch }) {
  const client = createClient({ fetchHandler: fetch })
  // ...
}
```

**Nuxt example:**

```typescript
// In server routes, use event.fetch
export default defineEventHandler((event) => {
  const client = createClient({ fetchHandler: event.fetch })
  // ...
})
```

**Next.js edge API route (if fetch is provided):**

```typescript
export default async function handler(request) {
  const client = createClient({ fetchHandler: request.fetch })
  // ...
}
```

> Recommended: use the fetch instance provided by the framework in handler/context code. ffetch also supports any fetch-compatible implementation and falls back to global fetch when no `fetchHandler` is provided.

## Troubleshooting

### Common Issues

#### "AbortSignal.timeout is not a function"

```
ffetch has an internal fallback, so this is usually non-fatal.

Optional: add a polyfill for AbortSignal.timeout
npm install abortcontroller-polyfill
```

#### "AbortSignal.any is not a function"

```
Solution: Either upgrade to Node.js 20.6+ or add a polyfill
npm install abort-controller-x
```

#### Timeout behaves as AbortError

```
This is expected in some environments. Check for both error types:

if (err instanceof TimeoutError || err instanceof AbortError) {
  // Handle timeout
}
```

#### CORS errors in browser

```
Solution: Ensure your server sends proper CORS headers
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
```

### Debug Mode

You can add verbose logging to troubleshoot issues:

```javascript
const client = createClient({
  hooks: {
    before: (req) => console.log('→', req.method, req.url),
    after: (req, res) => console.log('←', res.status),
    onError: (req, err) => console.error('✗', err),
  },
})
```
