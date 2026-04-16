# pi-neuralwatt-provider

A [pi](https://github.com/badlogic/pi) extension that adds [Neuralwatt](https://neuralwatt.com) as a custom model provider.

## Features

- **OpenAI-compatible API** - Uses Neuralwatt's `/v1/chat/completions` endpoint
- **Reasoning models** - Support for thinking models with `reasoning_effort` parameter
- **Vision models** - Image input support on Kimi K2.5
- **Tool use** - Function calling support
- **Streaming** - Real-time token streaming
- **Fast variants** - Optimized "Fast" versions of popular models for quicker responses

## Available Models

| Model | Context | Vision | Reasoning | Thinking Format | Input $/M | Output $/M |
|-------|---------|--------|-----------|-----------------|-----------|------------|
| Devstral Small 2 24B | 262K | ❌ | ✅ | `qwen` | $0.15 | $0.45 |
| GLM 5 Fast | 203K | ❌ | ❌ | — | $0.25 | $1.10 |
| GLM 5.1 Fast | 203K | ❌ | ❌ | — | $0.48 | $1.90 |
| GLM 5.1 FP8 | 203K | ❌ | ❌ | — | $0.50 | $2.10 |
| GPT-OSS 20B | 16K | ❌ | ✅ | `reasoning_effort` | $0.50 | $1.50 |
| Kimi K2.5 | 262K | ✅ | ✅ | `qwen` | $0.35 | $1.70 |
| Kimi K2.5 Fast | 262K | ❌ | ✅ | `qwen` | $0.25 | $1.25 |
| MiniMax M2.5 | 197K | ❌ | ❌ | — | $0.11 | $0.95 |
| Qwen3.5 35B A3B | 131K | ❌ | ✅ | `qwen` | $0.20 | $0.60 |
| Qwen3.5 397B A17B FP8 | 262K | ❌ | ✅ | `qwen` | $0.35 | $1.75 |
| Qwen3.5 397B Fast | 262K | ❌ | ✅ | `qwen` | $0.25 | $1.25 |


## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-neuralwatt-provider
```

Then set your API key and run pi:
```bash
export NEURALWATT_API_KEY=your-api-key-here
pi
```

Get your API key from [neuralwatt.com](https://neuralwatt.com).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone git@github.com:monotykamary/pi-neuralwatt-provider.git
   cd pi-neuralwatt-provider
   ```

2. Set your Neuralwatt API key:
   ```bash
   export NEURALWATT_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-neuralwatt-provider
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEURALWATT_API_KEY` | Yes | Your Neuralwatt API key from [neuralwatt.com](https://neuralwatt.com) |

## Configuration

### Compat Settings

Neuralwatt runs on vLLM, which requires specific compatibility settings for reasoning models. These are pre-configured in `models.json`:

- **`supportsDeveloperRole: false`** — All models. vLLM doesn't support the `developer` role; pi sends system prompts as `system` messages instead.
- **`thinkingFormat: "qwen"`** — Qwen, Kimi, and Devstral reasoning models. Sends `enable_thinking: true` in the request body to activate thinking mode.
- **`supportsReasoningEffort: true`** — GPT-OSS. Sends `reasoning_effort` parameter (maps to pi's `/reasoning` command levels).

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

## API Documentation

- Neuralwatt API: `https://api.neuralwatt.com/v1`
- Models endpoint: `https://api.neuralwatt.com/v1/models`
- Chat completions: `https://api.neuralwatt.com/v1/chat/completions`

## License

MIT
