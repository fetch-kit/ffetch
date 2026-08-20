---
'@fetchkit/ffetch': minor
---

Fixed

- Core: aborts and timeouts during retry backoff now reject with the correct terminal error instead of returning an earlier retryable response
- Core: `abortAll()` now cancels active physical requests
- Core: asynchronous `onRetry` hooks are awaited and their failures propagate correctly
- Hedge plugin: retryable responses no longer beat a pending successful attempt
- Hedge plugin: request bodies are safely cloned across retry and hedge attempts
- Hedge plugin: overall timeouts and `abortAll()` now cancel every in-flight hedge attempt
- Hedge plugin: lifecycle hooks run once per logical request instead of once per speculative attempt
- Hedge plugin: cancellation and errors from internal losing attempts no longer leak through public lifecycle hooks
- Bulkhead plugin: requests that abort or time out while queued are removed and reject with the correct error type
- Dedupe plugin: fully constructed `Request` bodies no longer disappear from request identity
- Dedupe plugin: additional callers can cancel independently without waiting for or cancelling the shared physical request
- Download progress plugin: invalid `Content-Length` values no longer produce `NaN`, and progress remains within the documented zero-to-one range

Documentation

- Clarified deduplication behavior for streamed request bodies, custom hash functions, and cancellation ownership
- Clarified download progress behavior for absent, invalid, or inaccurate `Content-Length` values

Tests

- Added property-based coverage for the core client, retries, hedging, retry and hedge interactions, circuit breaker, bulkhead, deduplication, and download progress
- Added 55 properties covering 27,450 generated cases
- Added regression coverage for preserving caller-provided context IDs across retries
