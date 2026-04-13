# Request Hedging

**Request hedging** is a technique for reducing tail latency by speculatively sending a duplicate request before the original has completed. If the original response arrives first, the duplicate is cancelled. If the duplicate arrives first (with an acceptable response), the original is cancelled.

Unlike retries — which wait for a failure before trying again — hedging sends parallel attempts proactively after a short delay. This means you don't pay the full round-trip cost of a failure; you just race two (or more) requests and take the winner.

Hedging is well-suited to idempotent endpoints where duplicate reads are harmless, and where a small percentage of requests are disproportionately slow (the "long tail").

Hedging is provided as an optional plugin.

## Import

```typescript
import { createClient } from '@fetchkit/ffetch'
import { hedgePlugin } from '@fetchkit/ffetch/plugins/hedge'
```

## Usage

```typescript
const client = createClient({
  plugins: [hedgePlugin({ delay: 50 })],
})

// After 50ms, a second attempt is sent to race the original
const response = await client('https://api.example.com/data')
// Fastest acceptable response wins; losers are cancelled
```

## Configuration

```typescript
const client = createClient({
  plugins: [
    hedgePlugin({
      delay: 50, // Delay before hedge fires
      maxHedges: 1, // Maximum hedge attempts
      shouldHedge: (req) => req.method === 'GET', // Only hedge safe requests
      onHedge: (req, attemptNumber) =>
        console.log(`Hedge attempt ${attemptNumber}`),
    }),
  ],
})
```

### Options

- `delay`: Number (ms) or function to determine delay before the first hedge attempt. Required.
- `maxHedges`: Maximum additional attempts to race (default: `1`).
- `shouldHedge`: Function to determine if a request should be hedged (default: safe methods only).
- `onHedge`: Optional callback fired when a hedge attempt is sent.
- `order`: Plugin execution order override (default: `15`).

## Behavior Notes

- Hedging is off unless the plugin is installed.
- **Winner policy**: First response that is not 5xx and not 429 becomes the winner. If all attempts settle without a winner, the last remaining attempt wins regardless of status.
- **Losers are cancelled**: When a winner is found, all other in-flight attempts are aborted via `AbortController` to prevent wasted bandwidth.
- **5xx and 429 are non-winners**: Hedge will wait for other attempts even if they arrive later.
- **4xx responses win immediately** (except 429).
- **Hedge vs. retries**: Hedge races parallel attempts; retries retry sequentially. Combining both multiplies traffic — generally prefer one or the other.
- **Safe methods only by default**: Hedging only applies to idempotent requests (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`). Use `shouldHedge` to customize.
- **Plugin ordering**: Hedge runs at order `15` (after dedupe at `10`, before circuit at `20`). Dedupe collapses callers before hedge races them.

## When to Use Hedge

- **Tail latency reduction**: Add hedging to reduce long-tail response times on slower networks.
- **Microservices**: Wire hedging between internal services to improve latency SLAs when latency variance matters.
- **Idempotent APIs**: Only hedge safe, idempotent methods.

## When NOT to Use Hedge

- **Already retrying**: Combining hedge + retries multiplies traffic and may overwhelm backends.
- **Mutable operations**: Never hedge POST or PATCH unless you're certain duplicates are safe. (`DELETE` is considered idempotent and is hedged by default.)
- **Rate-limited APIs**: Hedging sends extra requests; respect rate limits by tuning delay and maxHedges carefully.
- **Limited bandwidth**: On bandwidth-constrained connections, the duplicate traffic may not be worth the latency savings.

## Defaults

- `delay`: Required (no default)
- `maxHedges`: `1`
- `shouldHedge`: Only safe methods (GET, HEAD, OPTIONS, PUT, DELETE)
- `onHedge`: `undefined`
- `order`: `15`

## Integration with Other Plugins

- **Dedupe + Hedge**: Dedupe collapses N identical concurrent callers to 1 in-flight request. If that request is hedged, only 1 + maxHedges total fetches are sent regardless of N callers.
- **Hedge + Circuit**: Circuit sees the hedge winner response (not losers). If the winner is a 5xx, circuit can still count it. Hedging improves success rate, which helps prevent circuit trips.
- **Hedge + Retries**: Generally avoid combining. If you must, keep retries low and hedge delay high to avoid multiplicative traffic. Retries retry a failed attempt; hedge races parallel speculative attempts.
