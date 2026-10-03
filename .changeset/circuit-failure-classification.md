---
'@fetchkit/ffetch': patch
---

Count only the dependency's own failures towards the circuit breaker, and refuse an attempt at dispatch when the circuit opened while the request was waiting.

`circuitPlugin` counted every error that reached the pipeline, so a 4xx surfaced by `throwOnHttpError` as an `HttpError`, a `BulkheadFullError`, a request the caller aborted, and an error thrown by a hook or another plugin could all open the circuit. A failure is now the same set of signals retries use: a 5xx or 429 status - read from the response, and also from the response `throwOnHttpError` carries on the `HttpError` - or a `NetworkError`, `TimeoutError` or `RetryLimitError` thrown for the attempt. Anything else is ignored, except that a non-failure response, including a 4xx surfaced as an `HttpError`, resets the consecutive failure count the way a success does. Being refused locally is no longer evidence that the dependency is down.

Admission is also re-checked immediately before every attempt, rather than only when the request is prepared, so a request that was admitted while the circuit was closed and then waited - during a retry delay, for example - is refused instead of being dispatched into an open circuit. That refusal reaches the caller as a `CircuitOpenError` instead of being wrapped in a `RetryLimitError`, which described it as retries that ran out because of the dependency.

That last part is what the core now does for every plugin: a `RetryLimitError` describes an attempt that failed, and nothing else. An error raised while a request is being prepared for an attempt - a plugin refusing it in `beforeAttempt`, or a retry hook that throws - reaches the caller unchanged, so refusing a request no longer needs support from the core.
