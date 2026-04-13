# Request Bulkheading

**Request bulkheading** isolates concurrency pressure by limiting how many requests can be in flight at once for a client instance. Extra requests wait in a queue (optional max depth) instead of flooding downstream services.

This is useful when a single dependency gets slow and you want controlled backpressure instead of unbounded fan-out.

For the canonical option/type reference, see [api.md -> Bulkhead Plugin](./api.md#bulkhead-plugin).

## Import

```typescript
import { createClient } from '@fetchkit/ffetch'
import { bulkheadPlugin } from '@fetchkit/ffetch/plugins/bulkhead'
```

## Usage

```typescript
const client = createClient({
  plugins: [
    bulkheadPlugin({
      maxConcurrent: 10,
      maxQueue: 50,
    }),
  ],
})

const response = await client('https://api.example.com/data')
```

## Configuration

```typescript
const client = createClient({
  plugins: [
    bulkheadPlugin({
      maxConcurrent: 10,
      maxQueue: 50,
      onReject: (req) => {
        console.warn('Bulkhead queue full:', req.url)
      },
    }),
  ],
})
```

### Options

- `maxConcurrent`: Maximum number of in-flight requests allowed at once. Required.
- `maxQueue`: Maximum queued requests waiting for a slot. Optional; defaults to unlimited.
- `onReject`: Callback fired when a request is rejected because queue capacity is full.
- `order`: Plugin execution order override (default: `5`).

## Behavior Notes

- Bulkheading is off unless the plugin is installed.
- Requests up to `maxConcurrent` run immediately.
- Additional requests wait in FIFO order.
- If `maxQueue` is set and queue capacity is reached, new requests are rejected with `BulkheadFullError`.
- Queued requests aborted by the caller are removed from the queue and rejected with `AbortError`.
- Bulkhead state is observable via client extensions:
  - `client.activeCount`
  - `client.queueDepth`

## Defaults

- `maxConcurrent`: Required (no default)
- `maxQueue`: `undefined` (unlimited)
- `onReject`: `undefined`
- `order`: `5`

## Integration with Other Plugins

- **Bulkhead + Dedupe**: With defaults, bulkhead (`order: 5`) runs before dedupe (`order: 10`), so queued requests are gated before dedupe can collapse them. If you want dedupe to collapse callers before bulkhead slot acquisition, set `bulkheadPlugin({ ..., order: 15 })` (or any value above dedupe's order).
- **Bulkhead + Retries**: Each retry attempt reacquires a slot; high retry counts can increase queue pressure.
- **Bulkhead + Circuit**: Bulkhead controls concurrency while circuit controls failure gating. They address different failure modes and can be combined.
