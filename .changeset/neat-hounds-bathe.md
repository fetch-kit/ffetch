---
'@fetchkit/ffetch': minor
---

Fixed

- dedupePlugin: each deduplicated caller now receives an independent Response clone, preventing "body already used" errors when multiple concurrent callers consume the response body

Documentation

- deduplication: explained response cloning behaviour and auth header considerations for custom hashFn
- advanced: clarified that timeout acts as total duration cap including retry wait periods
