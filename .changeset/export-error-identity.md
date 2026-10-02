---
'@fetchkit/ffetch': patch
---

Share the error module across every entrypoint so the error classes keep a single identity. The CommonJS build previously inlined its own copy of the error classes into each bundle, so a `CircuitOpenError` thrown by `@fetchkit/ffetch/plugins/circuit` - or a `BulkheadFullError` thrown by `@fetchkit/ffetch/plugins/bulkhead` - failed `instanceof` against the same class imported from `@fetchkit/ffetch`. Errors thrown by the packaged plugins now satisfy `instanceof` against the root exports, in both the ESM and CommonJS builds.
