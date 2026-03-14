---
'@fetchkit/ffetch': major
---

Added

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
