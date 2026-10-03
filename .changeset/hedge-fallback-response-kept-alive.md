---
'@fetchkit/ffetch': patch
---

Fix `hedgePlugin` aborting the response it returns. When every attempt settled without a winner - for example a 5xx from the original attempt and a transport error from the hedge - the plugin aborted the last _launched_ attempt instead of the attempt that produced the returned fallback response, so the body of that response failed with `AbortError` and the real loser kept running. The plugin now tracks which attempt produced the fallback and aborts only the other attempts.
