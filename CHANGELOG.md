# ffetch

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
