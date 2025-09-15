---
'@gkoos/ffetch': minor
---

Added

- fetchHandler option to support pluggable/custom fetch implementations (SSR, edge, frameworks, polyfills).

Changed

- Removed manual AbortSignal combination fallback; AbortSignal.any is now required (native or polyfill).
- Removed tests and code paths relying on the old signal combination fallback.

Docs

- Updated documentation to clarify AbortSignal.any requirement and polyfill instructions.
