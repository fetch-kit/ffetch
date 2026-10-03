# ffetch

## 5.7.1

### Patch Changes

- 417b11c: Count only the dependency's own failures towards the circuit breaker, refuse an attempt at dispatch when the circuit opened while the request was waiting, and tell plugins which stage raised each error.

  `circuitPlugin` counted every error that reached the pipeline, so a 4xx surfaced by `throwOnHttpError` as an `HttpError`, a `BulkheadFullError`, a request the caller aborted, and an error thrown by a hook or another plugin could all open the circuit. A failure is now the same set of signals retries use: a 5xx or 429 status - read from the response, and also from the response `throwOnHttpError` carries on the `HttpError` - or a `NetworkError`, `TimeoutError` or `RetryLimitError` thrown for the attempt. Anything else is ignored, except that a non-failure response, including a 4xx surfaced as an `HttpError`, resets the consecutive failure count the way a success does. Being refused locally is no longer evidence that the dependency is down.

  Admission is also re-checked immediately before every attempt, rather than only when the request is prepared, so a request that was admitted while the circuit was closed and then waited - during a retry delay, for example - is refused instead of being dispatched into an open circuit. That refusal reaches the caller as a `CircuitOpenError` instead of being wrapped in a `RetryLimitError`, which described it as retries that ran out because of the dependency.

  That last part is what the core now does for every plugin: a `RetryLimitError` describes an attempt that failed, and nothing else. An error raised while a request is being prepared for an attempt - a plugin refusing it in `beforeAttempt`, or a retry hook that throws - reaches the caller unchanged, so refusing a request no longer needs support from the core.

  The core also states which stage raised the error it reports instead of leaving a plugin to infer it from the error's type. `ctx.metadata.provenance` is `'attempt'` when the request's own attempt raised the error and `'hook'` when local code did - a plugin refusing the request, a retry policy or `onRetry` hook that threw, a `transformResponse` or `after` hook that failed, another plugin's reporting hook - and a request that has not reached an attempt yet is local code. A `beforeAttempt` plugin that refuses with a `TimeoutError`, or a `transformResponse` hook that throws an `HttpError` carrying a 503, is therefore no longer read as a dependency failure by a plugin that classifies failures the way `circuitPlugin` does. `PluginProvenance` is exported for typing the field, and it is optional so a context built by hand still works and reads as local code.

  The core's own decision uses the same stage rather than comparing error objects, so a retry policy or hook that rethrows the attempt's own error (`throw ctx.error`) keeps its error instead of having it wrapped and relabelled as the dependency's.

- 04bb6b7: Run the retry sequence from one internal executor instead of three places.

  The loop, the attempt counter, the retry decision, the `onRetry` hook, the release of a discarded response body and the wait between attempts were split across `retry()`, the pipeline's `shouldRetryWithHook` wrapper and `runAttempt`, which each wrote part of `ctx.metadata.retry` and kept part of the state: the pipeline counted attempts a second time, guarded `onRetry` with a condition the loop had already applied, and only the pipeline's copy of the metadata write described the attempt a policy had just seen.

  `runRetrySequence` in `src/internals/retry-execution.ts` now owns the sequence, and the pipeline hands it the attempts to run, the policy, the hook and the metadata to keep up to date. The sequence keeps its shape: attempts are still numbered from 1, the policy is still consulted only for the attempts a retry budget can follow, `onRetry` still receives a zero-based retry number and still runs after the decision, before a discarded response body is cancelled and before the delay is waited out, a wait is still cut short by a cancellation, and an error raised by the policy, the hook or the attempt still reaches the caller with the same identity and provenance.

  Consolidating it also fixed two things the sequence reported that did not match what it documents. Both are visible to `shouldRetry`, `onRetry` and `ctx.metadata.retry`, and both are covered by tests now:

  - An attempt that fails is reported with its own error and no response. The context it was reported in also carried the response an earlier attempt left behind, so a policy that reads `response` could decide on a response that was no longer the answer, `onRetry` was told about it, and its body - already released when the retry discarded it - could be released again.
  - Every attempt is recorded in `ctx.metadata.retry`, the last one a request's budget allows included. That attempt used to leave the metadata on the attempt before it (or on `0` with `retries: 0`) while `onSuccess`, `onError` and `onFinally` ran, and `shouldRetryResult` kept the previous attempt's answer: it is now unset for an attempt that was never offered for a retry.

  `src/retry.ts` keeps the delay contract (`RetryDelay`, `defaultDelay`) and no longer exports the loop, which was internal to the pipeline either way: `retry()` was never part of the public API in `src/index.ts`.

- 94ee3f3: Skip `Blob` request bodies in the default dedupe hash, so distinct payloads that share a MIME type and size are no longer collapsed into one request.
- bad5ad1: Keep a client created with an empty plugin list usable in TypeScript.

  `createClient({ plugins: [] })`, `createClient({ plugins: [] as const })` and an options object typed as `FFetchOptions<[]>` produced an uncallable client: the plugin extensions inferred `never`, which made the whole client `never`, so a call failed with "This expression is not callable" and `pendingRequests`/`abortAll` appeared to be missing. `[]` infers `never[]` and `[] as const` infers `readonly []`, and for an empty plugin union `UnionToIntersection<never>` resolves to `unknown`, whose `Extract<..., object>` is `never`.

  - An empty plugin list now contributes an empty extension object instead of erasing the extensions, so the client and the promise its calls return stay usable.
  - Plugins installed through a non-empty list are unaffected: their extensions are still intersected into the client and into the call result.

- e71f995: Share the error module across every entrypoint so the error classes keep a single identity. The CommonJS build previously inlined its own copy of the error classes into each bundle, so a `CircuitOpenError` thrown by `@fetchkit/ffetch/plugins/circuit` - or a `BulkheadFullError` thrown by `@fetchkit/ffetch/plugins/bulkhead` - failed `instanceof` against the same class imported from `@fetchkit/ffetch`. Errors thrown by the packaged plugins now satisfy `instanceof` against the root exports, in both the ESM and CommonJS builds.
- 08c0dcd: Fix `hedgePlugin` aborting the response it returns. When every attempt settled without a winner - for example a 5xx from the original attempt and a transport error from the hedge - the plugin aborted the last _launched_ attempt instead of the attempt that produced the returned fallback response, so the body of that response failed with `AbortError` and the real loser kept running. The plugin now tracks which attempt produced the fallback and aborts only the other attempts.
- 62a5fff: Fix `hedgePlugin` letting `onHedge` errors escape request handling. A synchronous throw or a rejected promise from `onHedge` now rejects the request with that error and aborts every in-flight attempt, instead of surfacing as an unhandled rejection - or, for a synchronous throw, leaving the dispatch promise pending forever. A rejection that arrives after the race has already settled is ignored.
- 97dd5cb: Classify native `fetch` rejections instead of letting them fall through to `RetryLimitError`. Native `fetch` reports a cancellation with the abort reason of the signal it was given, so a timed-out request now rejects with a `DOMException` named `TimeoutError` rather than `AbortError`, and `controller.abort(reason)` rejects with `reason` verbatim - which may be a plain `Error` or a string. Both are now classified as `TimeoutError`/`AbortError`, fire the `onTimeout`/`onAbort` hooks, and are no longer retried. Network failures are also recognized in their Node shape - `TypeError('fetch failed')` with an `ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`/`ECONNRESET`/`ETIMEDOUT`/`UND_ERR_*` code in `cause`, or an `AggregateError` of them - in addition to the browser messages, so they reject with `NetworkError` instead of `RetryLimitError`. A custom `fetchHandler` that rejects with the library's own `AbortError` or `TimeoutError` keeps that classification instead of being re-wrapped as an `AbortError`, and any other rejection carrying one of those names - `got`'s `TimeoutError`, for example - is classified the same way. Safari's `Load failed` message is recognized as a network failure like the other browser messages.
- 12523a6: Propagate terminal transport and hook errors instead of returning the last response. A `transformResponse` or `after` hook that throws no longer resolves the request with the original response, and a network failure after an earlier response (for example a retried `503`) now rejects with `NetworkError` instead of returning the previously cancelled response.
- 44a835d: Replay the request body on every retry attempt. Sending a request consumes its body, so a retried request that carried a body was silently skipped and the previous response was returned instead.

  Only a body ffetch owns is replayed: a `string`, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed array or `FormData` passed in `init`. Other bodies keep the previous behaviour instead of being buffered before the first attempt:

  - a `ReadableStream` body or a `Request` input can be an upload that only ends when the server acknowledges it, so buffering one would stall the request;
  - a request replaced by a `transformRequest` hook is copied only when the retry starts, which still throws if the hook's body was already sent.

- 4d51fb6: Run the lifecycle to completion when a request fails while it is being prepared, and never leak a pending request.

  A hook that threw during preparation - `transformRequest`, `before`, or a plugin `preRequest` - rejected past the rest of the pipeline: core `onComplete` and plugin `onError`/`onFinally` were skipped, so a caller could not release what it had set up for the request.

  - Core `onComplete` now runs for a request that fails during preparation, and plugin `onError`/`onFinally` run whenever a request has entered the plugin pipeline.
  - `onError` and `onFinally` run for every plugin, even when one of them throws. A throwing `onFinally` still fails a request that succeeded, while a request that already failed keeps its own error; a throwing `onError` still replaces the failure it saw, which is how `circuitPlugin` reports an open circuit.
  - A request always leaves `client.pendingRequests`, so repeated hook failures no longer accumulate leaked entries.
  - A request is registered as soon as the call starts, so `client.abortAll()` and the caller's own signal settle a request that is still preparing, even when a preparation hook never resolves.

## 5.7.0

### Minor Changes

- 008e852: Add a `beforeAttempt` plugin lifecycle hook that runs before each physical fetch attempt (initial, retry, and hedged), and extend `contextIdPlugin` to emit a W3C `traceparent` header by default while preserving incoming trace context.

## 5.6.2

### Patch Changes

- 946a8d6: Changed

  - added a Node.js engine requirement to prevent unsupported installs

  Added

  - `CODE_OF_CONDUCT.md` and linked it from the contribution docs

## 5.6.1

### Patch Changes

- 6351f54: Changed

  - GitHub releases now include the exact npm tarball, signed SLSA build provenance, and an SBOM
  - Release provenance is verified against the tarball before publishing to npm
  - Migrated release automation to Changesets Action v2 with explicit GitHub App token handling

## 5.6.0

### Minor Changes

- f71bd75: Fixed

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

## 5.5.4

### Patch Changes

- 9d6df81: Fixed
  - Clone request on each retry attempt to prevent body-already-used error when retrying POST requests with a body

## 5.5.3

### Patch Changes

- 9497a5c: Fixed
  - DTS build by avoiding direct Buffer global usage in dedupe hash base64 encoding

## 5.5.2

### Patch Changes

- 09e831b: Dependencies
  - Updated linting, testing, and release-tooling dependencies
  - Updated GitHub Actions dependency set

## 5.5.1

### Patch Changes

- abc236c: Fixed
  - SBOM attachment to GitHub release assets

## 5.5.0

### Minor Changes

- f3be91f: Fixed
  - dedupePlugin: each deduplicated caller now receives an independent Response clone, preventing "body already used" errors when multiple concurrent callers consume the response body

  Documentation
  - deduplication: explained response cloning behaviour and auth header considerations for custom hashFn
  - advanced: clarified that timeout acts as total duration cap including retry wait periods

## 5.4.9 – 5.4.13

### Patch Changes

Internal CI/CD infrastructure releases. No functional changes.

- ci: automated publishing pipeline setup (Node 24, npm Trusted Publishing, OIDC)
- ci: GitHub Actions pinned to commit SHAs
- ci: CodeQL, Dependabot, OpenSSF Scorecard, SBOM generation configured
- ci: fine-grained PAT for changeset version PRs to trigger CI
- docs: README updated with security section and OpenSSF Scorecard badge

## 5.4.3 – 5.4.8

### Patch Changes

Internal CI/CD infrastructure releases. No functional changes.

- ci: automated publishing pipeline initial setup and stabilisation

## 5.4.2

### Patch Changes

- 4e50d1d: Documentation
  - Node Weekly mention added

## 5.4.1

### Patch Changes

- 5617c07: Documentation
  - Clarify AbortSignal.any requirement in advanced guide

## 5.4.0

### Minor Changes

- 0aa51b5: Added
  - Context id plugin

## 5.3.0

### Minor Changes

- b5a9a52: Added
  - Hedge plugin implemented
  - Bulkhead plugin implemented
  - Integration tests

  Changed
  - baseDispatch made context-driven so wrapDispatch plugins can inject modified request and signal per attempt

  Documentation
  - Reworked and improved

## 5.2.1

### Patch Changes

- 434c2f3: Documentation
  - Feature matrix updated in Readme

## 5.2.0

### Minor Changes

- 8543a59: Added
  - downloadProgressPlugin with streaming progress callbacks

## 5.1.1

### Patch Changes

- 77f6e07: Changed
  - Replaced string-based decoration marker with a Symbol in responseShortcutsPlugin to eliminate any possibility of key collision with third-party code

## 5.1.0

### Minor Changes

- 3095282: Added
  - Added first-party requestShortcutsPlugin for HTTP method shortcuts on the client (get, post, put, patch, delete, head, options)
  - Added first-party responseShortcutsPlugin for response parsing shortcuts on the returned request promise (json, text, blob, arrayBuffer, formData)

  Documentation
  - Reworked readme

## 5.0.1

### Patch Changes

- 20c43e2: Fixed
  - Retry backoff to wake immediately on abort/timeout.

## 5.0.0

### Major Changes

- 9633916: Added
  - Introduced a plugin-first architecture for optional client behavior
  - Added first-party Circuit Breaker plugin
  - Added first-party Deduplication plugin with configurable hashing and cleanup options
  - Added plugin extension support on the client for plugin-provided runtime state

  Changed
  - Refactored optional features to run through plugin lifecycle hooks instead of legacy feature flags
  - Improved package module structure and exports for plugin-based usage
  - Updated examples and guidance to reflect current runtime behavior and compatibility expectations

  Documentation
  - Expanded and clarified plugin architecture docs, migration guidance, hooks semantics, and compatibility notes
  - Corrected edge-case behavior descriptions around retries, circuit state/callbacks, and runtime environment support

  Tests
  - Increased coverage across core client flows and plugin behavior
  - Added/updated tests for circuit breaker and deduplication behavior, hook ordering semantics, retry behavior, and timeout/pending request scenarios
  - Strengthened regression coverage for documented behavior and migration paths

## 4.3.0

### Minor Changes

- 3e3bf19: Added
  - Optional dedupe map TTL cleanup
  - Test coverage improvement

## 4.2.0

### Minor Changes

- 0fa5ccf: - Allow fetchHandler to be overriden on a per-request basis

## 4.1.0

### Minor Changes

- cff44a3: Added
  - Optional request deduplication with customisable hash

## 4.0.12

### Patch Changes

- 0ceab1b: Added
  - Discord section to readme

## 4.0.11

### Patch Changes

- 2485bc8: Fixed
  - Discord announcement format

## 4.0.10

### Patch Changes

- 5a24353: Fixed
  - Github Action to post announcement to Discord

## 4.0.9

### Patch Changes

- e458152: Fixed
  - Discord announcement

## 4.0.8

### Patch Changes

- 9ad99a3: Fixed
  - Discord announcement

## 4.0.7

### Patch Changes

- 8f0075f: Fixed
  - Discord announcement GitHub action

## 4.0.6

### Patch Changes

- 1f7a45c: Fixed
  - Discord announcement

## 4.0.5

### Patch Changes

- aa8b557: Fixed
  - Discord announcement

## 4.0.4

### Patch Changes

- b5b706c: Fixed
  - Discord announcement

## 4.0.3

### Patch Changes

- 7ebb34c: Added
  - GitHub action to announce release on Discord

## 4.0.2

### Patch Changes

- 33228f8: Fixed
  - documentation

## 4.0.1

### Patch Changes

- 0c19c30: Fixed
  - links to github repo in docs

## 4.0.0

### Major Changes

- 512bd86: Added
  - throwOnHttpError flag added to config
  - unified and hardened error handling for all error types and edge cases

## 3.4.2

### Patch Changes

- fab14c2: Fixed
  - npm references in documentation

## 3.4.1

### Patch Changes

- be108a3: Changed
  - migrated to @fetchkit/ffetch

## 3.4.0

### Minor Changes

- 77d2968: Changed
  - Improved circuit breaker state handling and error propagation
  - Refactored CircuitBreaker logic to use recordResult for unified error/success tracking
  - Updated client to expose pendingRequests and abortAll as read-only properties via Object.defineProperty

## 3.3.0

### Minor Changes

- 4c79eb3: Added
  - Circuit breaker state exposed

## 3.2.0

### Minor Changes

- 504825e: Added
  - onCircuitClose hook added

  Changed
  - Unreachable code removed
  - Tests added to improve doe coverage

  Docs
  - Broken table in api.md fixed

## 3.1.0

### Minor Changes

- 6812b91: Added
  - fetchHandler option to support pluggable/custom fetch implementations (SSR, edge, frameworks, polyfills).

  Changed
  - Removed manual AbortSignal combination fallback; AbortSignal.any is now required (native or polyfill).
  - Removed tests and code paths relying on the old signal combination fallback.

  Docs
  - Updated documentation to clarify AbortSignal.any requirement and polyfill instructions.

## 3.0.0

### Major Changes

- a8bb7d4: Added
  - controller created and exposed in pendingRequests
  - abortAll() helper to abort all pending requests

## 2.0.0

### Major Changes

- 854591c: Added
  - tracking of pending requests

  Changed
  - AbortSignal.any fallback fixed
  - timeout(0) properly handled (no timeout)
  - signal combining fixed

  Docs
  - documentation refactored and expanded
  - migration guide added

## 1.2.0

### Minor Changes

- c6f94fb: Added:
  - Support for the HTTP Retry-After header in the default retry logic. If a server responds with a Retry-After header (in seconds or as a date), ffetch will honor it and use the specified delay before retrying.

## 1.1.0

### Minor Changes

- 22f70cd: Added
  - Support for modern AbortSignal.timeout and AbortSignal.any APIs (requires polyfill for Node <20 and older browsers).
  - cause property to all custom error classes for better error provenance.

  Changed
  - Refactored timeout and abort logic to use only AbortSignal APIs; removed manual timeout fallback.
  - Tests now strictly assert error types and .cause properties.
  - Improved test coverage for edge cases and fallback branches.

  Docs
  - Updated README with new prerequisites, error .cause documentation, and polyfill instructions.

## 1.0.1

### Patch Changes

- 4be1694: Minified build added

## 1.0.0

### Major Changes

- 0b8870d: Support for complex retry strategies implemented

## 0.3.0

### Minor Changes

- 057320b: - Export TypeScript types for hooks and the client function, enabling full type safety and autocompletion for consumers.
  - Add `transformRequest` and `transformResponse` hooks to allow advanced request/response transformation and customization.

## 0.2.0

### Minor Changes

- Add core resilience features:
  - **Timeouts:** Requests are aborted if they exceed a configurable timeout.
  - **Retries:** Failed requests are retried with customizable policy (`shouldRetry`), including exponential backoff and jitter.
  - **Circuit Breaker:** Automatically blocks requests after repeated failures, with auto-reset after cooldown.
  - **Hooks:** New lifecycle hooks for before, after, onError, onRetry, onTimeout, onAbort, onCircuitOpen, and onComplete, enabling advanced logging, metrics, and custom behaviors.

## 0.1.1

### Patch Changes

- Scaffolded TypeScript project:
  - `package.json` renamed to ffetch
  - `src/index.ts`, `src/client.ts`, `src/types.ts` created
  - `tsconfig.json` + `tsup.config.ts` for dual ESM/CJS build
- Tooling wired:
  - `npm run build`, `test`, `lint`, `format` scripts
  - Vitest + coverage + happy-dom env
  - Prettier + ESLint + Husky pre-commit hook
  - `.gitignore` added
- First test passes:
  - `test/client.test.ts` asserts `typeof createClient() === 'function'`
- Published v0.1.0 to npm registry:
  - `npm login` done
  - Manual npm version patch → v0.1.1 (changesets unused for initial setup)
