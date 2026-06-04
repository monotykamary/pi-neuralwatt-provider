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
    "sse_cost_raw": { /* : cost payload above */ }
  }
}
```

## Replay Semantics

| Field | Replay strategy | Source |
|-------|----------------|--------|
| `energy_joules` | **Cumulative** (sum across entries) | First-class |
| `cost_usd` | **Cumulative** (sum across entries) | First-class |
| MCR state (`session_fp`, `safe_drop_before`, `apc_hit_rate`, etc.) | **Latest-wins** (last entry in branch) | `sse_mcr_session_raw` + `sse_energy_raw.mcr` |

Energy and cost accumulate because they represent real resource consumption. MCR state is a point-in-time snapshot — the last value in a branch is the current state.

## Adding New Upstream Fields

No code changes needed in either `pi-neuralwatt-provider` or `pi-tps-web`. The raw SSE payloads are persisted verbatim and replay reads from them directly. New fields in `: energy`, `: mcr-session`, or `: cost` comments automatically appear in `sse_energy_raw`, `sse_mcr_session_raw`, and `sse_cost_raw` respectively.

To *display* a new field, update `buildEnergyText` in `index.ts`. To *surface* it in pi-tps-web, read from `EnergyPayload.sse_energy_raw` / `sse_mcr_session_raw` / `sse_cost_raw`.
