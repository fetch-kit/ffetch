---
'@fetchkit/ffetch': patch
---

Count only the dependency's own failures towards the circuit breaker, refuse an attempt at dispatch when the circuit opened while the request was waiting, and tell plugins which stage raised each error.

`circuitPlugin` counted every error that reached the pipeline, so a 4xx surfaced by `throwOnHttpError` as an `HttpError`, a `BulkheadFullError`, a request the caller aborted, and an error thrown by a hook or another plugin could all open the circuit. A failure is now the same set of signals retries use: a 5xx or 429 status - read from the response, and also from the response `throwOnHttpError` carries on the `HttpError` - or a `NetworkError`, `TimeoutError` or `RetryLimitError` thrown for the attempt. Anything else is ignored, except that a non-failure response, including a 4xx surfaced as an `HttpError`, resets the consecutive failure count the way a success does. Being refused locally is no longer evidence that the dependency is down.

Admission is also re-checked immediately before every attempt, rather than only when the request is prepared, so a request that was admitted while the circuit was closed and then waited - during a retry delay, for example - is refused instead of being dispatched into an open circuit. That refusal reaches the caller as a `CircuitOpenError` instead of being wrapped in a `RetryLimitError`, which described it as retries that ran out because of the dependency.

That last part is what the core now does for every plugin: a `RetryLimitError` describes an attempt that failed, and nothing else. An error raised while a request is being prepared for an attempt - a plugin refusing it in `beforeAttempt`, or a retry hook that throws - reaches the caller unchanged, so refusing a request no longer needs support from the core.

The core also states which stage raised the error it reports instead of leaving a plugin to infer it from the error's type. `ctx.metadata.provenance` is `'attempt'` when the request's own attempt raised the error and `'hook'` when local code did - a plugin refusing the request, a retry policy or `onRetry` hook that threw, a `transformResponse` or `after` hook that failed, another plugin's reporting hook - and a request that has not reached an attempt yet is local code. A `beforeAttempt` plugin that refuses with a `TimeoutError`, or a `transformResponse` hook that throws an `HttpError` carrying a 503, is therefore no longer read as a dependency failure by a plugin that classifies failures the way `circuitPlugin` does. `PluginProvenance` is exported for typing the field, and it is optional so a context built by hand still works and reads as local code.

The core's own decision uses the same stage rather than comparing error objects, so a retry policy or hook that rethrows the attempt's own error (`throw ctx.error`) keeps its error instead of having it wrapped and relabelled as the dependency's.
