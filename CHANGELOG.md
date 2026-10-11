# Changelog

## Unreleased

- Quiet startup sync: background `/v1/models` revalidation runs only with an API key, only when the disk cache is older than 1 hour (`PI_PROVIDER_SYNC_TTL_MS`, `0` = always), missing, or fetched with a different key, and only in one pi process at a time (lock file next to the cache). Failed refreshes back off for 5 minutes; sessions that skip adopt a cache refreshed by another process.
- Never store the API key: key changes are detected via a salted sha256 fingerprint in `cache/neuralwatt-models.sync.json`. The cache file format is unchanged.
- Startup quota/flex-usage poll: interactive sessions only, never without an API key, deduped across processes with a 2-minute snapshot in `cache/neuralwatt-account.json`; other sessions render the quota line from it. Turn-triggered quota refreshes keep their cadence, skip when no key is configured, and update the snapshot.
- Write the model cache atomically; flatten the session_start promise chains so nothing is awaited and every rejection is swallowed.
- Add vitest coverage for the sync policy, the session_start model sync and the startup account poll.

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
