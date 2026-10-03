---
'@fetchkit/ffetch': patch
---

Propagate terminal transport and hook errors instead of returning the last response. A `transformResponse` or `after` hook that throws no longer resolves the request with the original response, and a network failure after an earlier response (for example a retried `503`) now rejects with `NetworkError` instead of returning the previously cancelled response.
