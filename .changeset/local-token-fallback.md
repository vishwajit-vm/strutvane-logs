---
"@strutvane/logs": patch
---

In `APP_ENV=local`, a viewer request that is not from loopback (a dev server reached through Docker, WSL or a VM) now falls back to the configured `LOGS_VIEWER_TOKEN` instead of being refused outright; without a token, or without any credential in the request, it stays hidden (404).
