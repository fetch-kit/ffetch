---
'@gkoos/ffetch': minor
---

Added:

- Support for the HTTP Retry-After header in the default retry logic. If a server responds with a Retry-After header (in seconds or as a date), ffetch will honor it and use the specified delay before retrying.
