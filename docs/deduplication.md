# Request Deduplication

Deduplication is provided as an optional plugin.

For the canonical option/type reference, see [api.md -> Deduplication Plugin](./api.md#deduplication-plugin).

## Import

```typescript
import { createClient } from '@fetchkit/ffetch'
import {
  dedupePlugin,
  dedupeRequestHash,
} from '@fetchkit/ffetch/plugins/dedupe'
```

## Usage

```typescript
const client = createClient({
  plugins: [dedupePlugin()],
})

const p1 = client('https://api.example.com/data')
const p2 = client('https://api.example.com/data')
const [r1, r2] = await Promise.all([p1, p2])
// One network request, shared in-flight promise.
```

## Configuration

```typescript
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

### Options

- `hashFn`: Custom key function. Return `undefined` to skip dedupe for a request.
- `ttl`: Optional map-entry eviction TTL in milliseconds.
- `sweepInterval`: Sweeper interval in milliseconds when `ttl` is enabled.
- `order`: Plugin execution order override.

## Behavior Notes

- Deduplication is off unless the plugin is installed.
- The dedupe key is computed from the original request init/body before dispatch; if `transformRequest` changes request identity, use a custom `hashFn` that reflects the final semantics you need.
- TTL eviction only removes in-flight dedupe keys from the map.
- TTL eviction does not reject already in-flight request promises.
- Stream/FormData request bodies are skipped by the default hash strategy.

## Defaults

- `hashFn`: `dedupeRequestHash`
- `ttl`: `undefined` (disabled)
- `sweepInterval`: `5000`
- `order`: `10`

## Breaking Migration

Removed legacy options:

- `dedupe`
- `dedupeHashFn`
- `dedupeTTL`
- `dedupeSweepInterval`

Use `plugins: [dedupePlugin(...)]` instead.
