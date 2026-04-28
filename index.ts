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
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "neuralwatt": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export NEURALWATT_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-neuralwatt-provider
 *
 * Data flow:
 *   models.json         → auto-generated from Neuralwatt API (pricing, capabilities, limits from metadata)
 *   patch.json          → manual overrides only where API is wrong or incomplete (usually empty)
 *   custom-models.json  → exclusive/hidden/preview models not in the API
 *
 * Merge order: models.json → apply patch.json → merge custom-models.json → transform to pi format
 *
 * Then use /model to select from available models like Kimi K2.5, Kimi K2.6, GLM 5, GLM 5.1,
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
import { streamOpenAICompletions } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import models from "./models.json" with { type: "json" };
import customModels from "./custom-models.json" with { type: "json" };
import patches from "./patch.json" with { type: "json" };
import { transformContextForImageLimit } from "./transform";

// Suppress unused-import lint when patch.json is empty ({} resolves to void at runtime)
void patches;

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

/**
 * Cached API key resolved from ModelRegistry.
 *
 * Pi's core resolves the key via ModelRegistry before calling our streamSimple
 * handler (passed as options.apiKey), but we also cache it here so we can
 * resolve it in contexts where options.apiKey isn't available (e.g. quota
 * fetching, future features) and to make the dependency explicit.
 *
 * Resolution order (via ModelRegistry.getApiKeyForProvider):
 *   1. Runtime override (CLI --api-key)
 *   2. auth.json stored credentials (manual entry in ~/.pi/agent/auth.json)
 *   3. OAuth tokens (auto-refreshed)
 *   4. Environment variable (from auth.json or provider config)
 */
let cachedApiKey: string | undefined;

/**
 * Resolve the Neuralwatt API key via ModelRegistry and cache the result.
 * Called on session_start and whenever ctx.modelRegistry is available.
 */
async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("neuralwatt") ?? undefined;
}

// ─── Session State (event-sourced via pi.appendEntry) ─────────────────────────

/**
 * Per-request energy/cost event, persisted as a custom entry in the session.
 * On restore, we replay all entries in the current branch to rebuild totals.
 * This naturally handles branching, forking, and tree navigation.
 */
interface EnergyEvent {
  // Core totals (used for footer display)
  energy_joules: number;
  cost_usd: number;

  // —— Energy detail ——
  energy_kwh?: number;
  avg_power_watts?: number;
  duration_seconds?: number;
  attribution_method?: string;
  attribution_ratio?: number;
  ratio_was_capped?: boolean;
  uncapped_attribution_ratio?: number;
  uncapped_energy_joules?: number;
  uncapped_energy_kwh?: number;

  // —— Cost detail ——
  cache_savings_usd?: number;
  allowance_remaining_usd?: number;
  budget_remaining_usd?: number;
}

const ENERGY_ENTRY_TYPE = "neuralwatt-energy";

/** In-memory totals for the current branch (rebuilt on session_start / tree nav) */
let sessionEnergyJoules = 0;
let sessionCostUsd = 0;

/** Pending per-request metrics — accumulated during streaming, persisted on turn_end */
let pendingEnergyJoules = 0;
let pendingCostUsd = 0;

/** Full pending detail captured from SSE comments — persisted alongside totals on turn_end */
let pendingDetail: Partial<EnergyEvent> = {};

function resetSessionState() {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
  pendingDetail = {};
  // Note: cachedApiKey is not reset here — it's auth config, not session state.
  // It's re-resolved on session_start and session_tree events.
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
  vision?: {
    maxImagesPerRequest?: number;
  };
}

/**
 * Build the model list: regular models → apply patches → merge custom models → transform to pi format.
 * Regular models (models.json) now include pricing, capabilities, and limits from the API metadata.
 * Patches (patch.json) apply non-destructive overrides only where the API is wrong or incomplete.
 * Custom models (custom-models.json) take precedence over regular models with the same id,
 * and can also add models not present in the API (e.g., exclusive/preview models).
 */
function buildModelList(
  regular: NeuralwattModel[],
  custom: NeuralwattModel[],
  patchList: Record<string, any> = {},
): NeuralwattModel[] {
  const modelMap = new Map<string, NeuralwattModel>();

  // 1. Add regular models (from API)
  for (const model of regular) {
    modelMap.set(model.id, model);
  }

  // 2. Add/override with custom models (exclusive, hidden, preview models)
  for (const model of custom) {
    modelMap.set(model.id, model);
  }

  // 3. Apply patch overrides (deep-merge nested objects like compat, vision, cost)
  const NESTED_KEYS = new Set(["compat", "vision", "cost"]);
  for (const [id, patch] of Object.entries(patchList)) {
    const existing = modelMap.get(id);
    if (existing) {
      const merged = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (NESTED_KEYS.has(key) && typeof value === "object" && value !== null && typeof (merged as any)[key] === "object") {
          (merged as any)[key] = { ...(merged as any)[key], ...value };
        } else {
          (merged as any)[key] = value;
        }
      }
      modelMap.set(id, merged);
    }
  }

  return Array.from(modelMap.values());
}

const piModels = buildModelList(
  models as NeuralwattModel[],
  customModels as NeuralwattModel[],
  patches as Record<string, any>,
).map((model) => {
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
  if (model.vision) {
    result.vision = model.vision;
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
            pendingDetail.energy_kwh = energy.energy_kwh ?? pendingDetail.energy_kwh;
            pendingDetail.avg_power_watts = energy.avg_power_watts ?? pendingDetail.avg_power_watts;
            pendingDetail.duration_seconds = energy.duration_seconds ?? pendingDetail.duration_seconds;
            pendingDetail.attribution_method = energy.attribution_method ?? pendingDetail.attribution_method;
            pendingDetail.attribution_ratio = energy.attribution_ratio ?? pendingDetail.attribution_ratio;
            pendingDetail.ratio_was_capped = energy.ratio_was_capped ?? pendingDetail.ratio_was_capped;
            pendingDetail.uncapped_attribution_ratio = energy.uncapped_attribution_ratio ?? pendingDetail.uncapped_attribution_ratio;
            pendingDetail.uncapped_energy_joules = energy.uncapped_energy_joules ?? pendingDetail.uncapped_energy_joules;
            pendingDetail.uncapped_energy_kwh = energy.uncapped_energy_kwh ?? pendingDetail.uncapped_energy_kwh;
          } catch {
            // Malformed energy comment, ignore
          }
        } else if (trimmed.startsWith(": cost ")) {
          try {
            const cost = JSON.parse(trimmed.slice(7));
            pendingCostUsd += cost.request_cost_usd || 0;
            pendingDetail.cache_savings_usd = cost.cache_savings_usd ?? pendingDetail.cache_savings_usd;
            pendingDetail.allowance_remaining_usd = cost.allowance_remaining_usd ?? pendingDetail.allowance_remaining_usd;
            pendingDetail.budget_remaining_usd = cost.budget_remaining_usd ?? pendingDetail.budget_remaining_usd;
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
  // Pi's core resolves via ModelRegistry before calling streamSimple (options.apiKey).
  // cachedApiKey is our own ModelRegistry-resolved copy (resolved on session_start).
  const apiKey = options?.apiKey || cachedApiKey || "";
  if (!apiKey) {
    throw new Error(
      `No API key for Neuralwatt. Add it to ~/.pi/agent/auth.json, ` +
      `set NEURALWATT_API_KEY env var, or use --api-key.`,
    );
  }

  // Apply per-model image limit by dropping oldest images (FIFO)
  const maxImages = model.vision?.maxImagesPerRequest as number | undefined;
  const transformedContext = transformContextForImageLimit(context, maxImages);

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
    const stream = streamOpenAICompletions(neuralwattModel, transformedContext, {
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

  // After each turn: persist pending energy event (totals + full detail), update status
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingEnergyJoules > 0 || pendingCostUsd > 0) {
      const entry: EnergyEvent = {
        energy_joules: pendingEnergyJoules,
        cost_usd: pendingCostUsd,
        ...pendingDetail,
      };
      pi.appendEntry(ENERGY_ENTRY_TYPE, entry);
      sessionEnergyJoules += pendingEnergyJoules;
      sessionCostUsd += pendingCostUsd;
      pendingEnergyJoules = 0;
      pendingCostUsd = 0;
      pendingDetail = {};
    }
    updateEnergyStatus(ctx);
  });

  // On session start/resume: resolve API key via ModelRegistry, replay energy events
  pi.on("session_start", async (_event, ctx) => {
    resetSessionState();
    await resolveApiKey(ctx.modelRegistry);
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });

  // On tree navigation: replay energy events for the new branch
  pi.on("session_tree", async (_event, ctx) => {
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });
}
