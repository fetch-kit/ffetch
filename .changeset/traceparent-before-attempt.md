---
'@fetchkit/ffetch': minor
---

Add a `beforeAttempt` plugin lifecycle hook that runs before each physical fetch attempt (initial, retry, and hedged), and extend `contextIdPlugin` to emit a W3C `traceparent` header by default while preserving incoming trace context.
