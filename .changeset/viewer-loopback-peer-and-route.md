---
"@strutvane/logs": patch
---

Provider and viewer refinements:

- The provider's request lines use the `route` template from the `http.onResponse` payload when present, and fall back to the safe path otherwise.
- Viewer local mode also requires the client's socket address to be loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`) when it is known; other peers get a 404. When the address is unknown, only the host is checked, as before. New `isLoopbackAddress` helper.
