---
'@fetchkit/ffetch': patch
---

Run the lifecycle to completion when a request fails while it is being prepared, and never leak a pending request.

A hook that threw during preparation - `transformRequest`, `before`, or a plugin `preRequest` - rejected past the rest of the pipeline: core `onComplete` and plugin `onError`/`onFinally` were skipped, so a caller could not release what it had set up for the request.

- Core `onComplete` now runs for a request that fails during preparation, and plugin `onError`/`onFinally` run whenever the pipeline has started.
- `onError` and `onFinally` run for every plugin, even when one of them throws. A throwing `onFinally` still fails a request that succeeded, while a request that already failed keeps its own error; a throwing `onError` still replaces the failure it saw, which is how `circuitPlugin` reports an open circuit.
- A request always leaves `client.pendingRequests`, so repeated hook failures no longer accumulate leaked entries.
- A request is registered as soon as the call starts, so `client.abortAll()` also cancels a request that is still preparing.
