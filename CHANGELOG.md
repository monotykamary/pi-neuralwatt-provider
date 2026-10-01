# Changelog

## 1.18.30

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.
- Keep GLM-5.2 thinking-map regressions deterministic after the family moves into the deprecated catalog.

## 1.18.28

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Keep retired-model thinking regressions deterministic across catalog updates.
