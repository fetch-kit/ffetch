---
'@fetchkit/ffetch': patch
---

Fixed

- Clone request on each retry attempt to prevent body-already-used error when retrying POST requests with a body
