<div align="center">

# ⚡ pi-neuralwatt-provider

**Models + energy tracking via [Neuralwatt](https://neuralwatt.com)**

_Kimi, GLM, Qwen, DeepSeek — with real-time ⚡ energy/cost per session for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

![Energy Reporting Status Widget](assets/screenshot.jpg)

## Features

- **OpenAI-compatible API** - Uses Neuralwatt's `/v1/chat/completions` endpoint
- **Reasoning models** - Support for thinking models with `reasoning_effort` parameter
- **Vision models** - Image input support on Kimi K2.5, K2.6, and Devstral
- **Tool use** - Function calling support
- **Streaming** - Real-time token streaming
- **Fast variants** - Optimized "Fast" versions of popular models for quicker responses
- **Energy reporting** - Displays energy consumption (⚡J/mWh/Wh/kWh) and actual billed cost ($) in a dedicated status widget below the editor, tracked per-session
- **Quota display** - Shows subscription plan, kWh allocation, and credits remaining from your Neuralwatt account, right-aligned in the status widget
- **Configurable display** - Energy and quota can each be shown in the below-editor widget, the built-in status bar, or turned off entirely via a config file

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Output $/M |
|-------|---------|--------|-----------|-----------|------------|
| GLM-5.2 | 1.0M | ❌ | ✅ | $1.45 | $4.50 |
| GLM-5.2 (fast) | 1.0M | ❌ | ❌ | $1.45 | $4.50 |
| GLM-5.2 (flex) | 1.0M | ❌ | ✅ | $1.45 | $4.50 |
| GLM-5.2 (short, fast, flex) | 200K | ❌ | ❌ | $1.45 | $4.50 |
| GLM-5.2 (short, fast) | 200K | ❌ | ❌ | $1.45 | $4.50 |
| GLM-5.2 (short, flex) | 200K | ❌ | ✅ | $1.45 | $4.50 |
| GLM-5.2 (short) | 200K | ❌ | ✅ | $1.45 | $4.50 |
| Kimi K2.6 | 262K | ✅ | ✅ | $0.69 | $3.22 |
| Kimi K2.6 (flex) | 262K | ✅ | ✅ | $0.69 | $3.22 |
| Kimi K2.6 Fast | 262K | ✅ | ❌ | $0.69 | $3.22 |
| Kimi K2.6 Long (Virtual Context) | 1.0M | ✅ | ✅ | $0.69 | $3.22 |
| Kimi K2.7 Code | 262K | ✅ | ✅ | $0.95 | $4.00 |
| Kimi K2.7 Code (flex) | 262K | ✅ | ✅ | $0.95 | $4.00 |
| Qwen3.5 397B | 262K | ❌ | ✅ | $0.69 | $4.14 |
| Qwen3.5 397B Fast | 262K | ❌ | ❌ | $0.69 | $4.14 |
| Qwen3.6 35B | 131K | ✅ | ✅ | $0.29 | $1.15 |
| Qwen3.6 35B Fast | 131K | ✅ | ❌ | $0.29 | $1.15 |
| GLM-5 Long (MCR 1M) | 1.0M | ❌ | ✅ | $1.10 | $3.60 |
| GLM-5.1 Fast Long (MCR 1M) | 1.0M | ❌ | ❌ | $1.10 | $3.60 |
| Kimi K2.5 Long (MCR 1M) | 1.0M | ✅ | ✅ | $0.52 | $2.59 |

## Authentication

The Neuralwatt API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "neuralwatt": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `NEURALWATT_API_KEY`

Get your API key from [neuralwatt.com](https://neuralwatt.com).

## Installation

### Option 1: Using `pi install` (Recommended)

Install from npm:

```bash
pi install npm:pi-neuralwatt-provider
```

Or install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-neuralwatt-provider
```

### Option 2: With npm

Install from npm:

```bash
npm install npm:pi-neuralwatt-provider
```

### Option 3: Manual Clone

Then authenticate and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export NEURALWATT_API_KEY=your-api-key-here

pi
```

1. Clone this repository:
   ```bash
   git clone git@github.com:monotykamary/pi-neuralwatt-provider.git
   cd pi-neuralwatt-provider
   ```

2. Configure your Neuralwatt API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export NEURALWATT_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-neuralwatt-provider
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEURALWATT_API_KEY` | No | Your Neuralwatt API key (fallback if not in auth.json) |

## Configuration

### Compat Settings

Neuralwatt's API provides compatibility and capability metadata (pricing, reasoning, vision, `developer_role`, `reasoning_effort`, `max_images`) directly in the `/v1/models` response. The `update-models.js` script reads these and writes them into `models.json`. Only genuinely incorrect API data needs a manual override in `patch.json`.

Currently configured compat settings:

- **`supportsDeveloperRole: false`** — All models. vLLM doesn't support the `developer` role; pi sends system prompts as `system` messages instead.
- **`supportsReasoningEffort: true`** — GLM-5.2. Sends the `reasoning_effort` parameter (maps pi's `/reasoning` levels onto GLM-5.2's native `high`/`max`/`minimal` via `thinkingLevelMap`).
- **`requiresReasoningContentOnAssistantMessages: true`** — Kimi K2.6/K2.7 reasoning variants. Pi-ai replays the model's prior-turn `reasoning` field on every assistant message so the model can continue its chain-of-thought across turns. All Neuralwatt reasoning models get this Layer-A replay automatically (the gateway aliases `reasoning` ↔ `reasoning_content`); this flag adds an empty `reasoning_content` scaffold for turns with no thinking block.
- **`chatTemplateKwargs`** — Raw `chat_template_kwargs` merged into every request via pi-ai's `onPayload` hook, mirroring vLLM's request field of the same name. Used to opt reasoning models into **full-history reasoning preservation** (vLLM's Jinja templates otherwise trim older assistant reasoning in alternating chat). The flags are template-level and family-specific — NOT a generic boolean:
  - **Kimi K2.6 / K2.7** → `{ "preserve_thinking": true }` — keeps the full reasoning history across turns (doc-backed; behavioral E2E: 0/6 → 6/6 recall).
  - **GLM-5.2 family** → `{ "clear_thinking": false }` — stops the template clearing older reasoning (functional: 1/4 → 4/4 recall, confirmed family-wide).
  - **GLM-5.1 / Qwen3.x / non-reasoning `-fast`** — no kwarg (their templates expose no flag; they rely on Layer-A replay only).

  These are injected alongside `reasoning_effort` (NOT via `thinkingFormat: "chat-template"`, which would displace the OpenAI `reasoning_effort` path) so thinking-level control and full-history preservation coexist.

### Custom Stream Handler

This extension registers a custom `streamSimple` provider (`api: "neuralwatt"`) that wraps pi-ai's built-in `streamOpenAICompletions`. A temporary `globalThis.fetch` override tees the HTTP response body so the OpenAI SDK handles all standard chunk parsing (text, thinking, tool calls, usage) while the extension reads the tee for Neuralwatt's SSE comment lines (`: energy {...}`, `: cost {...}`) that the SDK discards.

### Pi Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-neuralwatt-provider"
  ]
}
```

## Usage

Once loaded, select a model with:

```
/model neuralwatt kimi-k2.5
```

Or use `/models` to browse all available Neuralwatt models.

### Reasoning Effort

For reasoning models, control thinking depth:

```
/reasoning high
```

Values: `none`, `low`, `medium`, `high`

Full-history reasoning preservation is **on by default** for Kimi K2.6/K2.7 and the GLM-5.2 family (see [Compat Settings](#compat-settings)). Override it per-model via [Model Overrides](#model-overrides).

## Display Configuration

Energy and quota are independently configurable. Create `~/.pi/agent/extensions/neuralwatt.json`:

```json
{
  "energy": "widget",
  "quota": "widget",
  "mcr": "widget",
  "carbon": "widget"
}
```

The file is auto-populated with defaults on first run.

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `energy` | `"widget"`, `"statusbar"`, `"off"` | `"widget"` | Energy/cost display mode |
| `quota` | `"widget"`, `"statusbar"`, `"off"` | `"widget"` | Quota display mode |
| `mcr` | `"widget"`, `"statusbar"`, `"off"` | `"widget"` | MCR (context-reuse) display mode |
| `carbon` | `"widget"`, `"statusbar"`, `"off"` | `"widget"` | Carbon (session CO₂ + fleet grid/region badge) display mode |
| `hideOnOtherProvider` | `true`, `false` | `false` | Hide all Neuralwatt display when a non-Neuralwatt model is active |

**Display modes:**

- **`"widget"`** — Shown in the dedicated below-editor status line. Energy on the left, quota on the right, padded to terminal width.
- **`"statusbar"`** — Shown in the built-in pi status bar. When both are set to `"statusbar"`, they're combined with a ` | ` separator: `⚡X J $Y | plan ● kWh ∙ $bal`.
- **`"off"`** — Hidden entirely. For `"quota": "off"`, the `/v1/quota` API fetch is also skipped (saving a network round-trip). Energy data is still parsed from the SSE stream and persisted to the session even when `"off"`.

`mcr` and `carbon` follow the same three modes. `carbon` adds two segments: **session CO₂** (`🌱X g CO₂`, on the energy line — cumulative, like energy) and a **fleet grid/region badge** (on the quota line — the latest request's electricity grid, e.g. `🇺🇸 PJM 416`). The badge compresses flag → intensity → balancing-authority tag as the terminal narrows, and a `~` marks intensities from a fallback carbon source. The badge also renders **standalone** (on its own) when `quota` is `off`, so the fleet location still shows.

**Example — custom quota footer:** If you use your own unified quota footer extension, disable the built-in quota display to avoid duplication:

```json
{
  "energy": "widget",
  "quota": "off"
}
```

### Model Overrides

`modelOverrides` lets you override compat flags and other model properties per model id, **on top of** `patch.json` + `custom-models.json`, without editing the extension. Keyed by model id; `compat` and `thinkingLevelMap` are deep-merged (toggle one flag without redeclaring the rest), scalars are replaced. Applied at session start, so edits take effect on the next `pi` session.

```jsonc
{
  "energy": "widget",
  "quota": "widget",
  "mcr": "widget",
  "carbon": "widget",
  "hideOnOtherProvider": false,
  "modelOverrides": {
    // Disable full-history reasoning for kimi-k2.6 (e.g. to save tokens):
    "kimi-k2.6":      { "compat": { "chatTemplateKwargs": { "preserve_thinking": false } } },
    // Override a single thinking level without redeclaring the map:
    "glm-5.2":        { "thinkingLevelMap": { "high": "max" }, "compat": { "chatTemplateKwargs": { "clear_thinking": true } } },
    // Force a smaller image cap:
    "kimi-k2.7-code": { "vision": { "maxImagesPerRequest": 4 } }
  }
}
```

The full set of overridable fields matches the model schema (`compat`, `thinkingLevelMap`, `vision`, `cost`, `contextWindow`, `maxTokens`, `reasoning`, `input`). See [Compat Settings](#compat-settings) for the catalog of compat flags and what `chatTemplateKwargs` values mean per family.

### Settings UI

`/neuralwatt-settings` opens an interactive settings panel (mirrors pi core's `/settings` — bordered `SettingsList`, Esc to go back) to configure Neuralwatt without editing JSON by hand:

- **Preserved thinking** (nested submenu, one row per model) — toggles `clear_thinking` (GLM-5.2 family) / `preserve_thinking` (Kimi K2.6/K2.7) in `modelOverrides` between **Preserve Thinking** (keep full reasoning history across turns; the default, `clear_thinking: false`) and **Clear Thinking** (let the template drop older reasoning; saves tokens, but can degrade multi-turn recall / cause overthinking).
- **Energy / Quota / MCR / Carbon display** (`widget` / `statusbar` / `off`) and **Hide on other provider** — the same fields as [Display Configuration](#display-configuration), editable live.

Changes write to `~/.pi/agent/extensions/neuralwatt.json` (raw read-modify-write, so unrelated fields survive), refresh the in-memory config, and re-register the provider, so they take effect immediately — no restart needed.

When you switch to — or start pi on — a Neuralwatt model that carries a preserved-thinking flag (e.g. the GLM-5.2 family, GLM-5.1, Kimi K2.6/K2.7), an info notification reports the state and how to change it, e.g. `Preserved thinking ON for glm-5.2 (clear_thinking: false) — suited for coding, but not for prose. Open /neuralwatt-settings to change.` (OFF reads `... reasoning trimmed each turn (lighter; better for prose) ...`). It's an ordinary info notification (not a warning), so it doesn't paint bright yellow.

## Energy Reporting

Neuralwatt provides real-time energy consumption data with every API response. This extension captures it and displays a running total in a dedicated status widget between the editor and the pi footer:

| Segment | Meaning |
|---------|----------|
| `⚡0.8mWh` | Cumulative session energy consumption (auto-scaled: J → mWh → Wh → kWh) |
| `$0.003952` | Cumulative session actual billed cost from Neuralwatt |
| `🌱1.24 g CO₂` | Cumulative session CO₂ emissions (auto-scaled: mg → g → kg); on the energy line when `carbon` is on |
| `pro` | Your Neuralwatt subscription plan |
| `●` | Subscription status indicator (● = active, ⊘ = past due/paused) |
| `31.7/33.0 kWh` | kWh remaining / kWh included in your plan |
| `∙ $64.55` | Credits remaining on your account |
| `🔑 .../.../mo` | Key allowance usage (if set on your API key) |
| `🇺🇸 PJM 416` | Fleet grid/region badge (latest request's electricity grid + its carbon intensity, g/kWh); on the quota line when `carbon` is on. A `~` marks fallback intensities |

The energy and cost data comes from Neuralwatt's SSE stream comments (`: energy` and `: cost`), which the standard OpenAI SDK discards. This extension uses a custom stream handler that parses raw SSE to capture them.

Energy is measured directly from GPU hardware using NVIDIA's NVML. For concurrent requests, Neuralwatt uses token-weighted attribution to fairly calculate your share. See [Neuralwatt's energy methodology](https://portal.neuralwatt.com/docs/energy-methodology) for details.

The same `: energy` comment carries the electricity grid the GPU node drew from (`grid_id`), that grid's carbon intensity, and the resulting CO₂e. The fleet routes across multiple grids, so `grid_id` is latest-wins (the "current" grid) while session CO₂ accumulates like energy. `grid_id` is either a bare ISO country code (`FI`) or an EIA/Electricity-Maps-style `CC-SUBREGION-BA` code (`US-MIDA-PJM`); the badge parses it generically (country flag via regional indicators, balancing-authority tag as the short form), so any new grid renders without a code change.

### Persistence

Energy, cost, carbon, and grid data are persisted per-request as custom session entries. On session resume or tree navigation, the totals are rebuilt by replaying all events in the current branch — CO₂ accumulates like energy, while `grid_id`/intensity are latest-wins. This means:

- **Session resume** — Energy/cost/carbon totals (and the latest grid) are restored when you continue a session
- **Branching** — Navigating to a different point in the session tree shows the correct totals for that branch
- **Forking** — Forked sessions carry their energy (and carbon) history forward

### Per-turn energy event

After every Neuralwatt turn (in the `turn_end` handler, once the SSE tee has drained), the extension emits a `neuralwatt:turn-energy` event on pi's shared event bus so other extensions can surface the energy-billed cost without re-parsing the session. The payload:

| Field           | Type     | Description                                                                         |
| --------------- | -------- | ----------------------------------------------------------------------------------- |
| `costUsd`       | `number` | Actual billed cost for this request (USD)                                           |
| `energyJoules` | `number` | Energy consumed for this request (Joules)                                           |
| `turnIndex`     | `number \| null` | pi's turn index for correlation. `null` if the event didn't carry one.       |

The event is only emitted for turns with Neuralwatt activity (the `pending*` state is per-request), so non-Neuralwatt turns never produce a spurious zero-cost signal. Consumers should correlate on `turnIndex` and treat a missing/`null` index defensively.


## API Documentation

- Neuralwatt API: `https://api.neuralwatt.com/v1`
- Models endpoint: `https://api.neuralwatt.com/v1/models`
- Chat completions: `https://api.neuralwatt.com/v1/chat/completions`

## License

MIT
