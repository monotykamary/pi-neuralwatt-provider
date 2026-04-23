# pi-neuralwatt-provider

A [pi](https://github.com/badlogic/pi-mono) extension that adds [Neuralwatt](https://neuralwatt.com) as a custom model provider.

## Features

- **OpenAI-compatible API** - Uses Neuralwatt's `/v1/chat/completions` endpoint
- **Reasoning models** - Support for thinking models with `reasoning_effort` parameter
- **Vision models** - Image input support on Kimi K2.5
- **Tool use** - Function calling support
- **Streaming** - Real-time token streaming
- **Fast variants** - Optimized "Fast" versions of popular models for quicker responses
- **Energy reporting** - Displays energy consumption (⚡J/mWh/Wh/kWh) and actual billed cost ($) in the pi footer, tracked per-session

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Output $/M |
|-------|---------|--------|-----------|-----------|------------|
| Devstral Small 2 24B Instruct 2512 | 262K | ❌ | ❌ | $0.15 | $0.45 |
| Glm 5 Fast | 203K | ❌ | ❌ | $0.25 | $1.10 |
| Glm 5.1 Fast | 203K | ❌ | ❌ | $0.48 | $1.90 |
| GLM 5.1 FP8 | 203K | ❌ | ✅ | $0.50 | $2.10 |
| GPT OSS 20b | 16K | ❌ | ✅ | $0.50 | $1.50 |
| Kimi K2.5 | 262K | ✅ | ✅ | $0.35 | $1.70 |
| Kimi K2.5 Fast | 262K | ❌ | ❌ | $0.25 | $1.25 |
| Kimi K2.6 | 262K | ✅ | ✅ | $0.70 | $3.20 |
| Kimi K2.6 Fast | 262K | ❌ | ❌ | $0.70 | $3.20 |
| MiniMax M2.5 | 197K | ❌ | ✅ | $0.11 | $0.95 |
| Qwen3.5 35b Fast | 131K | ❌ | ✅ | $0.25 | $1.25 |
| Qwen3.5 397b A17B FP8 | 262K | ❌ | ✅ | $0.35 | $1.75 |
| Qwen3.5 397b Fast | 262K | ❌ | ❌ | $0.25 | $1.25 |
| Qwen3.6 35b A3B | 131K | ❌ | ❌ | $0.30 | $1.00 |
| Qwen3.6 35b Fast | 131K | ❌ | ❌ | $0.25 | $1.25 |

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

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-neuralwatt-provider
```

Then authenticate and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export NEURALWATT_API_KEY=your-api-key-here

pi
```

### Option 2: Manual Clone

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

Neuralwatt runs on vLLM, which requires specific compatibility settings for reasoning models. These are pre-configured in `models.json`:

- **`supportsDeveloperRole: false`** — All models. vLLM doesn't support the `developer` role; pi sends system prompts as `system` messages instead.
- **`thinkingFormat: "qwen"`** — Qwen, Kimi, and Devstral reasoning models. Sends `enable_thinking: true` in the request body to activate thinking mode.
- **`supportsReasoningEffort: true`** — GPT-OSS. Sends `reasoning_effort` parameter (maps to pi's `/reasoning` command levels).

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

## Energy Reporting

Neuralwatt provides real-time energy consumption data with every API response. This extension captures it and displays a running total in the pi footer:

```
↑11k ↓1.5k R16k $0.006  4.6%/262k (auto)                             (neuralwatt) moonshotai/Kimi-K2.6
⚡1.4mWh $0.006915 ◆ 5 points / 1 snapshots
```

The energy indicator (`⚡... $...`) appears on the bottom status line alongside other extension statuses like `◆ snapshots`. It does not replace the standard pi footer.

| Segment | Meaning |
|---------|----------|
| `⚡0.8mWh` | Cumulative session energy consumption (auto-scaled: J → mWh → Wh → kWh) |
| `$0.003952` | Cumulative session actual billed cost from Neuralwatt |

The energy and cost data comes from Neuralwatt's SSE stream comments (`: energy` and `: cost`), which the standard OpenAI SDK discards. This extension uses a custom stream handler that parses raw SSE to capture them.

Energy is measured directly from GPU hardware using NVIDIA's NVML. For concurrent requests, Neuralwatt uses token-weighted attribution to fairly calculate your share. See [Neuralwatt's energy methodology](https://portal.neuralwatt.com/docs/energy-methodology) for details.

### Persistence

Energy and cost data is persisted per-request as custom session entries. On session resume or tree navigation, the totals are rebuilt by replaying all events in the current branch. This means:

- **Session resume** — Energy/cost totals are restored when you continue a session
- **Branching** — Navigating to a different point in the session tree shows the correct totals for that branch
- **Forking** — Forked sessions carry their energy history forward

## API Documentation

- Neuralwatt API: `https://api.neuralwatt.com/v1`
- Models endpoint: `https://api.neuralwatt.com/v1/models`
- Chat completions: `https://api.neuralwatt.com/v1/chat/completions`

## License

MIT
