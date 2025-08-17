---
'@gkoos/ffetch': minor
---

Added

- Support for modern AbortSignal.timeout and AbortSignal.any APIs (requires polyfill for Node <20 and older browsers).
- cause property to all custom error classes for better error provenance.

Changed

- Refactored timeout and abort logic to use only AbortSignal APIs; removed manual timeout fallback.
- Tests now strictly assert error types and .cause properties.
- Improved test coverage for edge cases and fallback branches.

Docs

- Updated README with new prerequisites, error .cause documentation, and polyfill instructions.
