---
'@gkoos/ffetch': minor
---

Changed

- Improved circuit breaker state handling and error propagation
- Refactored CircuitBreaker logic to use recordResult for unified error/success tracking
- Updated client to expose pendingRequests and abortAll as read-only properties via Object.defineProperty
