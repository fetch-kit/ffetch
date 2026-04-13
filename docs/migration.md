# Migration Guide

This guide covers migration to ffetch v5.0.0, with focus on the breaking move from config-based optional features to plugins.

## Who Needs This Guide

Use this guide if your v4 code uses any of these options:

- `dedupe`
- `dedupeHashFn`
- `dedupeTTL`
- `dedupeSweepInterval`
- `circuit`

## v5.0.0 Breaking Changes

1. Root import is named-only.
2. Optional features moved to plugin modules.
3. Legacy top-level feature flags are removed.

## 1) Import Changes

### Before (v4)

> This section is historical v4 syntax for comparison only. Do not copy these snippets into v5 code.

```typescript
import createClient from '@fetchkit/ffetch'
```

### After (v5)

```typescript
import { createClient } from '@fetchkit/ffetch'
```

## 2) Feature Flag Migration Map

| v4 Option                       | v5 Replacement                                   |
| ------------------------------- | ------------------------------------------------ |
| `dedupe: true`                  | `plugins: [dedupePlugin()]`                      |
| `dedupeHashFn`                  | `dedupePlugin({ hashFn })`                       |
| `dedupeTTL`                     | `dedupePlugin({ ttl })`                          |
| `dedupeSweepInterval`           | `dedupePlugin({ sweepInterval })`                |
| `circuit: { threshold, reset }` | `plugins: [circuitPlugin({ threshold, reset })]` |

## 3) Dedupe Migration

### Before (v4)

```typescript
import createClient from '@fetchkit/ffetch'

const client = createClient({
  dedupe: true,
  dedupeHashFn: (params) => `${params.method}|${params.url}|${params.body}`,
  dedupeTTL: 30_000,
  dedupeSweepInterval: 5_000,
})
```

### After (v5)

```typescript
import { createClient } from '@fetchkit/ffetch'
import { dedupePlugin } from '@fetchkit/ffetch/plugins/dedupe'

const client = createClient({
  plugins: [
    dedupePlugin({
      hashFn: (params) => `${params.method}|${params.url}|${params.body}`,
      ttl: 30_000,
      sweepInterval: 5_000,
    }),
  ],
})
```

## 4) Circuit Breaker Migration

### Before (v4)

```typescript
import createClient from '@fetchkit/ffetch'

const client = createClient({
  retries: 0,
  circuit: { threshold: 5, reset: 30_000 },
  hooks: {
    onCircuitOpen: (req) => console.warn('Circuit opened:', req.url),
    onCircuitClose: (req) => console.info('Circuit closed:', req.url),
  },
})
```

### After (v5)

```typescript
import { createClient } from '@fetchkit/ffetch'
import { circuitPlugin } from '@fetchkit/ffetch/plugins/circuit'

const client = createClient({
  retries: 0,
  plugins: [
    circuitPlugin({
      threshold: 5,
      reset: 30_000,
      onCircuitOpen: ({ request, reason }) =>
        console.warn('Circuit opened:', request.url, reason.type),
      onCircuitClose: ({ request, response }) =>
        console.info('Circuit closed:', request.url, response.status),
    }),
  ],
})
```

## 5) Circuit State Access

When `circuitPlugin` is installed, `client.circuitOpen` is available as a plugin extension.

```typescript
if (client.circuitOpen) {
  console.warn('Circuit is open')
}
```

TypeScript tip: keep plugin lists as tuples for best inference.

```typescript
const plugins = [circuitPlugin({ threshold: 5, reset: 30_000 })] as const
const client = createClient({ plugins })
```

## 6) Quick Upgrade Checklist

1. Replace default root import with named root import.
2. Add plugin imports from:
   - `@fetchkit/ffetch/plugins/dedupe`
   - `@fetchkit/ffetch/plugins/circuit`

- `@fetchkit/ffetch/plugins/request-shortcuts` (optional)
- `@fetchkit/ffetch/plugins/response-shortcuts` (optional)

3. Move dedupe and circuit config into `plugins: [...]`.
4. Move circuit callbacks from `hooks` into `circuitPlugin(...)` options.
5. Run tests and verify no legacy options remain.

## Native Fetch Users

If migrating directly from native `fetch`, start with:

```typescript
import { createClient } from '@fetchkit/ffetch'

const client = createClient({
  timeout: 5000,
  retries: 2,
})
```

Then add plugins only when needed.

## Optional: Convenience Shortcuts Plugins

### Client HTTP Method Shortcuts

```typescript
import { createClient } from '@fetchkit/ffetch'
import { requestShortcutsPlugin } from '@fetchkit/ffetch/plugins/request-shortcuts'

const client = createClient({
  plugins: [requestShortcutsPlugin()],
})

const usersResponse = await client.get('https://api.example.com/users')
const createdResponse = await client.post('https://api.example.com/users', {
  body: JSON.stringify({ name: 'Alice' }),
  headers: { 'content-type': 'application/json' },
})
```

This plugin is opt-in and adds `get` / `post` / `put` / `patch` / `delete` / `head` / `options` methods to the client.

### Request Promise Parsing Shortcuts

v5.0.0 also includes an optional response shortcuts plugin for promise-chain parsing.

```typescript
import { createClient } from '@fetchkit/ffetch'
import { responseShortcutsPlugin } from '@fetchkit/ffetch/plugins/response-shortcuts'

const client = createClient({
  plugins: [responseShortcutsPlugin()],
})

const users = await client('https://api.example.com/users').json()
```

This is opt-in and does not change default behavior for clients that do not install the plugin.
