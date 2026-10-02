---
'@fetchkit/ffetch': patch
---

Skip `Blob` request bodies in the default dedupe hash, so distinct payloads that share a MIME type and size are no longer collapsed into one request.
