---
'@fetchkit/ffetch': patch
---

Fix `hedgePlugin` letting `onHedge` errors escape request handling. A synchronous throw or a rejected promise from `onHedge` now rejects the request with that error and aborts every in-flight attempt, instead of surfacing as an unhandled rejection - or, for a synchronous throw, leaving the dispatch promise pending forever. A rejection that arrives after the race has already settled is ignored.
