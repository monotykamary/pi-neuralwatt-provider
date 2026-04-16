/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (api.neuralwatt.com) as a custom provider using the openai-completions API.
 * Base URL: https://api.neuralwatt.com/v1
 *
 * Usage:
 *   # Set your API key
 *   export NEURALWATT_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-neuralwatt-provider
 *
 * Then use /model to select from available models like Kimi K2.5, GLM 5, GLM 5.1,
 * Qwen3.5, GPT-OSS 20B, Devstral Small 2, and MiniMax M2.5.
 *
 * Neuralwatt Features:
 *   - OpenAI-compatible API (https://api.neuralwatt.com/v1)
 *   - Reasoning/thinking models
 *   - Vision models (Kimi K2.5)
 *   - Tool use support
 *   - Streaming support
 *
 * @see https://neuralwatt.com
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import models from "./models.json" with { type: "json" };

// Pi's expected model structure
interface PiModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  };
}

// Neuralwatt model data structure from JSON
interface NeuralwattModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;      // $ per million input tokens
    output: number;     // $ per million output tokens
    cacheRead: number;  // $ per million cached tokens
    cacheWrite: number; // $ per million cache write tokens
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  };
}

// Transform JSON model to Pi's expected format
function transformModel(model: NeuralwattModel): PiModel {
  const result: PiModel = {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };

  // Pass compat settings through if present
  if (model.compat) {
    result.compat = model.compat;
  }

  return result;
}

const piModels = (models as NeuralwattModel[]).map(transformModel);

export default function (pi: ExtensionAPI) {
  pi.registerProvider("neuralwatt", {
    baseUrl: "https://api.neuralwatt.com/v1",
    apiKey: "NEURALWATT_API_KEY",
    api: "openai-completions",
    models: piModels,
  });
}
