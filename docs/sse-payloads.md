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
    "flex_discount_pct_est": 35,
    "consumed_cost_usd_est": 4.3e-05
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
| `flex_discount_pct_est` | fixed **35** — Neuralwatt pricing is **energy-based**; per the flex-tier docs the discount is a constant 0.65 multiplier on the charged amount ("today"; wait-time buckets with different discounts are on the roadmap) |
| `consumed_cost_usd_est` | `charged / 0.65` — the standard-price equivalent for this request |

**Do not compare charged cost against token list prices.** `request_cost_usd` is derived from the energy pool the request ran in, not from token counts — the ratio vs token list prices swings wildly (observed 2%–98%) and is meaningless. An earlier revision divided the two and presented the result as a queue-scaled discount; it was wrong in both value and direction (a "−83%" badge was not "actually −17%" — under energy-based pricing it was never a discount measure at all; the true discount is −35% per the docs).

### Measuring the multiplier from account usage

The discount constant is auto-verified at runtime so upstream changes (wait-
time buckets, a new multiplier) are reflected without a release. Wherever the
quota is refreshed, the extension also fetches `GET /v1/usage/summary` and
`GET /v1/usage/by-model` (trailing 7 days) and derives the effective
multiplier from the documented billing identity:

```
charged_kwh = standard_consumed_kwh + M × flex_consumed_kwh
          M = 1 − (consumed − charged) / Σ products[*-flex].energy_kwh
```

The measurement is used only when: `accounting_method` is "energy"; the flex
volume is ≥ 0.02 kWh (below that, millikWh truncation swamps the ratio); flex
kWh < total consumed; and the result lands in (0.05, 1.0]. Otherwise it falls
back to the documented 0.65. Windows are kept post-2026-07-24 because older
flex traffic groups under served-model rows. Verified on a real account
(2026-08): consumed 48.735 kWh vs charged 48.672 kWh with 0.167 kWh of flex
volume ⇒ M ≈ 0.62 — consistent with the documented 0.65 within cutover and
truncation noise.

The footer badge (`flex −N%`) and `flex_discount_pct_est` write the
effective (measured-or-documented) discount; `consumed_cost_usd_est` divides
by the same effective multiplier.

The footer energy line gains a sticky badge for the latest flex request: `flex −35% · queued ~6m05s` (progressively dropped to `flex −35%`, then hidden, before carbon compresses). A standard-tier turn clears the badge. Replay restores it latest-wins from `service_tier`/`flex_discount_pct_est`/`queue_seconds` on each entry (discount restored to the documented constant regardless of legacy derived values).

The `neuralwatt:turn-energy` event payload gains `serviceTier` and `flexDiscountPctEst`.

### Requested upstream fields (supersede the estimate when shipped)

Asked of upstream: explicit `consumed_cost_usd`, `discount_usd` / `flex_discount_pct`, and `queue_seconds` on the `: cost` comment (and the non-stream cost object); once present they flow into `sse_cost_raw` verbatim with no client change, and the estimate should be replaced by the real value.


### Live footer queue indicator

While a `-flex` model's stream is in flight, the energy widget's flex badge
switches to a live wait ticker rendered as a fixed-width m:ss clock
(`flex queued 00:12`; when a previous flex turn exists in the session the
full tier keeps its discount: `flex −35% · queued 02:05`, saturating at
`99:59+`). It refreshes once a second after a 2s grace window (requests that
start generating immediately never flicker a badge), appears even before the
session's first completed turn, and clears when the stream settles. The clock
must stay constant-width: a growing wait string would nudge the right side of
the widget against its compression budget on every rollover. Detection keys
off the model id suffix client-side — SSE heartbeats carry no `service_tier`,
so a queued flex request would otherwise be invisible until generation starts.

## Billed Cost Flows Into pi's Own Cost Surfaces

The extension wraps the assistant-message event stream so the final `done`
message's `usage.cost` is rewritten to the metered billed cost (data-chunk
`cost_usd` first, `: cost` comment sum as fallback) instead of pi-ai's
list-priced token cost — see `wrapStreamWithBilledCost` /
`applyBilledCostToUsage`. pi computes footers, session totals and /stats by
scanning committed entries' `usage.cost`, so after this rewrite every pi cost
surface reflects the actual bill (flex discounts included) as soon as the
turn finishes. One ordering caveat: the usage chunk (which pi-ai list-prices)
arrives *before* the cost frames, so anyone reading cost mid-stream must wait
for the tee reader to settle — hence the wrapper awaits it at `done`.

## Adding New Upstream Fields

No code changes needed in either `pi-neuralwatt-provider` or `pi-tps-web`. The raw SSE payloads are persisted verbatim and replay reads from them directly. New fields in `: energy`, `: mcr-session`, or `: cost` comments automatically appear in `sse_energy_raw`, `sse_mcr_session_raw`, and `sse_cost_raw` respectively.

To *display* a new field, update `buildEnergyText` in `index.ts`. To *surface* it in pi-tps-web, read from `EnergyPayload.sse_energy_raw` / `sse_mcr_session_raw` / `sse_cost_raw`.
