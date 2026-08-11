# SSE Payload Reference

Neuralwatt's streaming API emits SSE comment lines (prefix `: `) that the OpenAI SDK discards. Our custom `streamSimple` handler tees the response body to capture them. These payloads are stored verbatim in each JSONL entry under `EnergyEvent` and are the source of truth for MCR replay — future upstream fields flow through without code changes.

## Payload Types

### `: energy`

Emitted once per request after the last data chunk. Contains energy consumption, carbon attribution, and MCR compaction metadata.

```jsonc
{
  // Energy
  "energy_joules": 20.44,
  "energy_kwh": 5.679e-06,
  "avg_power_watts": 4087.0,
  "duration_seconds": 1.479,

  // Attribution
  "attribution_method": "prorated_token_pool_weighted_multi_gpu_8",
  "attribution_ratio": 0.0034,

  // Carbon
  "carbon_g_co2eq": 0.0002726,
  "grid_carbon_intensity_gco2perkwhr": 48.0,
  "grid_id": "FI",
  "carbon_source": "agent_cache",

  // MCR (nested)
  "mcr": {
    "compaction_triggered": false,
    "inference_energy_joules": 20.44,
    "compaction_energy_joules": 0.0,
    "session_turns": 1,
    "context_tokens": 5,
    "mode": "virtual_context",
    "summaries_used": 0,
    "sync_compaction_ran": false,
    "chunks_pending_compaction": 0,
    "original_tokens": 14,
    "all_chunks_cached": false,
    "mcr_compacted_tokens": 0,
    "mcr_original_tokens": 14,
    "session_fp": "8d8fb39168e7f5d0e7582b2b",
    "apc_hit_tokens": 0,
    "apc_miss_tokens": 5,
    "apc_hit_rate": 0.0,
    "current_turn_new_tokens": 297
  }
}
```

### `: mcr-session`

Emitted once per request (MCR models only). Contains the session fingerprint and context-drop boundary.

```jsonc
{
  "session_fp": "8d8fb39168e7f5d0e7582b2b",
  "stored_through": 1,
  "safe_drop_before": 0,
  "apc_hit_tokens": 0,
  "apc_miss_tokens": 5,
  "apc_hit_rate": 0.0,
  "current_turn_new_tokens": 297
}
```

### `: cost`

Emitted once per request after the last data chunk. Contains billing and quota information.

```jsonc
{
  "request_cost_usd": 2.8e-05,
  "cache_savings_usd": 0.0,
  "allowance_remaining_usd": 79.623536,
  "budget_remaining_usd": 79.623536
}
```

## JSONL Storage

Each `turn_end` writes a `neuralwatt-energy` custom entry to the session JSONL:

```jsonc
{
  "type": "custom",
  "customType": "neuralwatt-energy",
  "data": {
    // First-class fields (used for cumulative replay)
    "energy_joules": 20.44,
    "cost_usd": 2.8e-05,

    // Verbatim SSE payloads (source of truth for MCR replay)
    "sse_energy_raw": { /* : energy payload above */ },
    "sse_mcr_session_raw": { /* : mcr-session payload above */ },
    "sse_cost_raw": { /* : cost payload above */ },

    // Derived per-request telemetry captured from SSE data chunks
    // (present only when the stream declared a service_tier; the _est
    // fields are computed client-side, not upstream-verbatim)
    "service_tier": "flex",
    "usage_tokens": { "prompt": 17, "completion": 64, "cached_input": 0 },
    "queue_seconds": 350,
    "flex_discount_pct_est": 98,
    "list_cost_usd_est": 2.27e-04
  }
}
```

## Replay Semantics

| Field | Replay strategy | Source |
|-------|----------------|--------|
| `energy_joules` | **Cumulative** (sum across entries) | First-class |
| `cost_usd` | **Cumulative** (sum across entries) | First-class |
| MCR state (`session_fp`, `safe_drop_before`, `apc_hit_rate`, etc.) | **Latest-wins** (last entry in branch) | `sse_mcr_session_raw` + `sse_energy_raw.mcr` |
| Flex badge (`flex_discount_pct_est`, `queue_seconds`) | **Latest-wins**; an entry with non-flex `service_tier` clears it | First-class (derived) |

Energy and cost accumulate because they represent real resource consumption. MCR state is a point-in-time snapshot — the last value in a branch is the current state.

## Flex Tier

Flex models (`*-flex`) are a discounted async tier: requests may be held server-side during peak until a capacity gap opens. Observed live behavior (2026-02, per-request probes against glm-5.2-flex, glm-5.2-short-flex, deepseek-v4-flash-flex, kimi-k2.7-code-flex):

- **Energy and cost are returned exactly like standard models** — same `: energy` / `: cost` comments at the end of the stream. Any report of "flex returns no energy" is almost certainly a client aborting while the request is queued (the comments only arrive after the final data chunk, so an early abort loses them).
- **Queued requests stream heartbeat chunks**: a `data:` frame every ~10s with an empty delta, no `service_tier`, and a `created` timestamp that advances with each beat:

  ```jsonc
  data: {"id": "…", "created": 1786466258, "model": "glm-5.2-short-flex", "choices": [{"index": 0, "delta": {}, "finish_reason": null}]}
  ```

  Generation then starts with normal content chunks. Observed queue waits: 0s (immediate) up to ~6 minutes.
- Every content/usage chunk carries `"service_tier": "flex"` (vs `"standard"`), and the response header `x-nw-service-tier: flex`.
- **Non-stream requests to a `-flex` model are served as `service_tier: "standard"`** (energy/cost are top-level objects in the JSON response, as usual).
- **No explicit discount field exists anywhere** (cost payload, pricing metadata, headers). Flex list pricing in `/models` is identical to the base model; the discount is only visible implicitly in `request_cost_usd` (observed ~60–98% below list, scaling with queue time — measured `request_cost_usd` is not purely token-derived, so treat client-side math as an estimate).

### Derived telemetry (client-side)

The tee reader additionally scans SSE `data:` lines (cheap regexes only; content chunks are never re-parsed — the SDK does that on the other tee branch):

| Field | How it's derived |
|-------|------------------|
| `service_tier` | `"service_tier"` on any content/usage chunk |
| `usage_tokens` | the final chunk's `usage` object (the one chunk we do parse), including `prompt_tokens_details.cached_tokens` |
| `queue_seconds` | `created` of the first content-bearing chunk − `created` of the first heartbeat chunk (undefined when never queued) |
| `flex_discount_pct_est` | `round((1 − charged / list) × 100)` where list is the same token counts at the model's list rates (cached input billed at `cacheRead`); clamped to 0–99 |
| `list_cost_usd_est` | the list-price estimate used above |

The footer energy line gains a sticky badge for the latest flex request: `flex −82% · queued ~6m05s` (progressively dropped to `flex −82%`, then hidden, before carbon compresses). A standard-tier turn clears the badge. Replay restores it latest-wins from `service_tier`/`flex_discount_pct_est`/`queue_seconds` on each entry.

The `neuralwatt:turn-energy` event payload gains `serviceTier` and `flexDiscountPctEst`.

### Requested upstream fields (supersede the estimate when shipped)

Asked of upstream: explicit `list_cost_usd`, `discount_usd` / `flex_discount_pct`, and `queue_seconds` on the `: cost` comment (and the non-stream cost object); once present they flow into `sse_cost_raw` verbatim with no client change, and the estimate should be replaced by the real value.


## Adding New Upstream Fields

No code changes needed in either `pi-neuralwatt-provider` or `pi-tps-web`. The raw SSE payloads are persisted verbatim and replay reads from them directly. New fields in `: energy`, `: mcr-session`, or `: cost` comments automatically appear in `sse_energy_raw`, `sse_mcr_session_raw`, and `sse_cost_raw` respectively.

To *display* a new field, update `buildEnergyText` in `index.ts`. To *surface* it in pi-tps-web, read from `EnergyPayload.sse_energy_raw` / `sse_mcr_session_raw` / `sse_cost_raw`.
