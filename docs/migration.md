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
      onCircuitOpen: (req) => console.warn('Circuit opened:', req.url),
      onCircuitClose: (req) => console.info('Circuit closed:', req.url),
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

## 6) Runtime Guard for Legacy Options

v5 throws a clear runtime error if removed options are still present in client options or per-request init.

## 7) Quick Upgrade Checklist

1. Replace default root import with named root import.
2. Add plugin imports from:
   - `@fetchkit/ffetch/plugins/dedupe`
   - `@fetchkit/ffetch/plugins/circuit`
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
