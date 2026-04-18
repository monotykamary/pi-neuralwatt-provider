/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (api.neuralwatt.com) as a custom provider with energy-aware streaming.
 * Base URL: https://api.neuralwatt.com/v1
 *
 * Neuralwatt returns energy consumption data (kWh, Joules) and request cost with every
 * API response. This extension captures that data via a custom stream handler that tees
 * the HTTP response (the OpenAI SDK discards SSE comments), then displays it in the pi footer.
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
 *   - Energy reporting per-request (Joules, kWh, watts, duration)
 *   - Request cost reporting (USD)
 *
 * @see https://neuralwatt.com
 */

import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { getEnvApiKey, streamOpenAICompletions } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import models from "./models.json" with { type: "json" };

// ─── Session State (event-sourced via pi.appendEntry) ─────────────────────────

/**
 * Per-request energy/cost event, persisted as a custom entry in the session.
 * On restore, we replay all entries in the current branch to rebuild totals.
 * This naturally handles branching, forking, and tree navigation.
 */
interface EnergyEvent {
  energy_joules: number;
  cost_usd: number;
}

const ENERGY_ENTRY_TYPE = "neuralwatt-energy";

/** In-memory totals for the current branch (rebuilt on session_start / tree nav) */
let sessionEnergyJoules = 0;
let sessionCostUsd = 0;

/** Pending per-request metrics — accumulated during streaming, persisted on turn_end */
let pendingEnergyJoules = 0;
let pendingCostUsd = 0;

function resetSessionState() {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
}

/**
 * Replay all energy events from the session branch to rebuild totals.
 */
function replayEnergyEvents(ctx: any): void {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENERGY_ENTRY_TYPE && entry.data) {
      sessionEnergyJoules += entry.data.energy_joules || 0;
      sessionCostUsd += entry.data.cost_usd || 0;
    }
  }
}

/**
 * Build the status text for the neuralwatt energy/cost indicator.
 */
function buildEnergyStatusText(): string | undefined {
  if (sessionEnergyJoules <= 0 && sessionCostUsd <= 0) return undefined;
  const energyStr = formatEnergy(sessionEnergyJoules);
  const costStr = formatCost(sessionCostUsd);
  return `⚡${energyStr} ${costStr}`;
}

/**
 * Update the footer status indicator with current energy/cost totals.
 * Uses theme.fg("dim", ...) for grey text.
 */
function updateEnergyStatus(ctx: any): void {
  const text = buildEnergyStatusText();
  ctx.ui.setStatus("neuralwatt", text ? ctx.ui.theme.fg("dim", text) : undefined);
}

// ─── Model Configuration ─────────────────────────────────────────────────────

interface NeuralwattModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
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

const piModels = (models as NeuralwattModel[]).map((model) => {
  const result: any = {
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
  if (model.compat) {
    result.compat = model.compat;
  }
  return result;
});

// ─── Energy Formatting ────────────────────────────────────────────────────────

/**
 * Format energy in Joules to the most readable unit.
 * Uses: J → mWh → Wh → kWh with appropriate precision.
 */
function formatEnergy(joules: number): string {
  if (joules === 0) return "0J";
  // 1 Wh = 3600 J, 1 mWh = 3.6 J, 1 kWh = 3,600,000 J
  if (joules < 3.6) {
    return joules < 10 ? `${joules.toFixed(1)}J` : `${Math.round(joules)}J`;
  }
  const mwh = joules / 3600;
  if (mwh < 1000) {
    return mwh < 10 ? `${mwh.toFixed(1)}mWh` : `${Math.round(mwh)}mWh`;
  }
  const wh = mwh / 1000;
  if (wh < 1000) {
    return wh < 10 ? `${wh.toFixed(1)}Wh` : `${Math.round(wh)}Wh`;
  }
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)}kWh`;
}

/**
 * Format cost in USD. Shows appropriate precision for small amounts.
 */
function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (usd < 1) return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

// ─── SSE Comment Reader ──────────────────────────────────────────────────────

/**
 * Read SSE comment lines (`: energy {...}`, `: cost {...}`) from a tee'd response body.
 * Runs concurrently with the OpenAI SDK's consumption of the original stream.
 */
async function readEnergyFromTee(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith(": energy ")) {
          try {
            const energy = JSON.parse(trimmed.slice(9));
            pendingEnergyJoules += energy.energy_joules || 0;
          } catch {
            // Malformed energy comment, ignore
          }
        } else if (trimmed.startsWith(": cost ")) {
          try {
            const cost = JSON.parse(trimmed.slice(7));
            pendingCostUsd += cost.request_cost_usd || 0;
          } catch {
            // Malformed cost comment, ignore
          }
        }
      }
    }
  } catch {
    // Tee stream may error if the main stream is aborted — that's fine
  }
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

const BASE_URL = "https://api.neuralwatt.com/v1";

/**
 * Neuralwatt's custom stream handler.
 *
 * Wraps pi-ai's built-in `streamOpenAICompletions` with a temporary `globalThis.fetch`
 * override that tees the HTTP response body. This lets the OpenAI SDK handle all
 * standard chunk parsing (text, thinking, tool calls, usage) while we read the
 * tee for Neuralwatt's SSE comment lines (`: energy`, `: cost`) that the SDK discards.
 */
function streamNeuralwatt(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  // Ensure the model uses openai-completions API so streamOpenAICompletions works
  const neuralwattModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || BASE_URL };

  // Temporarily override globalThis.fetch to tee the response body.
  // The SDK consumes one branch; we read the other for SSE comments.
  const originalFetch = globalThis.fetch;
  let teeReader: Promise<void> | undefined;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    // Only tee streaming responses to Neuralwatt's chat completions endpoint
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (response.body && url.includes("/chat/completions")) {
      const [bodyForSdk, bodyForEnergy] = response.body.tee();
      teeReader = readEnergyFromTee(bodyForEnergy);
      return new Response(bodyForSdk, { headers: response.headers, status: response.status, statusText: response.statusText });
    }
    return response;
  };

  try {
    // Delegate all chunk parsing to the built-in handler
    const stream = streamOpenAICompletions(neuralwattModel, context, {
      ...options,
      apiKey,
    });

    // When the stream ends, restore fetch and wait for our tee reader to finish
    const originalEnd = stream.end.bind(stream);
    stream.end = (result?: any) => {
      globalThis.fetch = originalFetch;
      // Don't block the stream end on our tee reader — it should finish around the same time
      if (teeReader) {
        teeReader.catch(() => {});
      }
      originalEnd(result);
    };

    return stream;
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register provider with custom stream handler
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "NEURALWATT_API_KEY",
    api: "neuralwatt",
    models: piModels,
    streamSimple: streamNeuralwatt,
  });

  // After each turn: persist pending energy event, update status
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingEnergyJoules > 0 || pendingCostUsd > 0) {
      pi.appendEntry(ENERGY_ENTRY_TYPE, {
        energy_joules: pendingEnergyJoules,
        cost_usd: pendingCostUsd,
      } as EnergyEvent);
      sessionEnergyJoules += pendingEnergyJoules;
      sessionCostUsd += pendingCostUsd;
      pendingEnergyJoules = 0;
      pendingCostUsd = 0;
    }
    updateEnergyStatus(ctx);
  });

  // On session start/resume: replay energy events from session entries
  pi.on("session_start", async (_event, ctx) => {
    resetSessionState();
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });

  // On tree navigation: replay energy events for the new branch
  pi.on("session_tree", async (_event, ctx) => {
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });
}
