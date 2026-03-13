# Request Deduplication

ffetch supports automatic deduplication of in-flight HTTP requests. This feature ensures that identical requests are only sent once, and all callers receive the same response promise.

## How Deduplication Works

- When deduplication is enabled, ffetch computes a deduplication key for each request using a hash function.
- If a request with the same key is already in flight, subsequent callers receive the same promise.
- Once the request completes, all waiting callers are resolved or rejected together.

## Configuration

Deduplication can be enabled globally or per-request:

```js
const client = createClient({ dedupe: true })
client('https://api.example.com/data', { dedupe: true })
```

### Optional Dedupe Map TTL

You can optionally enable stale-entry eviction for the internal dedupe map:

```js
const client = createClient({
  dedupe: true,
  dedupeTTL: 30_000, // Evict dedupe entries older than 30s
  dedupeSweepInterval: 5_000, // Check every 5s
})
```

Behavior notes:

- Deduplication works with or without TTL.
- `dedupeTTL` only controls eviction of dedupe-map keys.
- TTL eviction does **not** reject an already in-flight request promise.
- `dedupeSweepInterval` only matters when `dedupeTTL` is a positive number.

### Custom Hash Function

You can provide a custom hash function to control how deduplication keys are generated:

```js
const client = createClient({
  dedupe: true,
  dedupeHashFn: (params) => `${params.method}|${params.url}|${params.body}`,
})
```

The default hash function considers method, URL, and body. For advanced use cases, you can include headers or other request properties.

## Defaults

- Deduplication is **off** by default. Enable it via the `dedupe` option.
- The default hash function is `dedupeRequestHash`, which handles common body types and skips deduplication for streams and FormData.
- `dedupeTTL` is `undefined` by default (TTL eviction disabled).
- `dedupeSweepInterval` defaults to `5000` ms.

## Limitations

- **Stream bodies** (`ReadableStream`, `FormData`): Deduplication is skipped for requests with these body types, as they cannot be reliably hashed or replayed.
- **Non-idempotent requests**: Use deduplication with caution for non-idempotent methods (e.g., POST), as it may suppress multiple intended requests.
- **Custom hash function**: Ensure your hash function uniquely identifies requests to avoid accidental deduplication.
- **TTL scope**: `dedupeTTL` does not cache final responses. It only evicts in-flight dedupe keys from the internal map.

## Example

```js
const client = createClient({ dedupe: true })
// These two requests will be deduped and only one fetch will occur
const p1 = client('https://api.example.com/data')
const p2 = client('https://api.example.com/data')
const [r1, r2] = await Promise.all([p1, p2])
```

## Summary

Deduplication in ffetch helps reduce redundant network traffic and ensures consistent responses for identical requests. Configure it as needed, and be aware of its limitations for certain body types and request methods.
