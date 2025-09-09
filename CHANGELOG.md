# ffetch

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
