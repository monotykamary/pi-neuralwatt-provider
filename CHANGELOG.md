# Changelog

## 1.19.0

- Discover Clef and future decision models as native pi classifiers; reuse System One auth, typed answers, usage, hooks, errors and cancellation instead of chat APIs.
- Preserve classifier registration through model sync, caches and MCR re-registration; regenerate the authenticated catalog.
- Respect separate per-turn and whole-conversation image ceilings, including migration of old cached limits.
- Add opt-in hosted tools on Chat Completions/Responses, delegated cost/energy ceilings, and a request-level opt-out. Invalid opt-in config fails closed.
- Preserve per-model sampling parameters through config and catalog merges.
- Add offline real-host classifier checks and an opt-in credential-safe live capability probe; validate Pi 1.0.0 and the bundled Pi 1.0.2 host.
- Keep retired GLM regressions independent of the expiring live graveyard.


## 1.18.30

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.
- Keep GLM-5.2 thinking-map regressions deterministic after the family moves into the deprecated catalog.

## 1.18.28

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Keep retired-model thinking regressions deterministic across catalog updates.
