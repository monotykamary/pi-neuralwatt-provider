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
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json → transform
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
 * Then use /model to select from available models like Kimi K2.5, Kimi K2.6, GLM 5, GLM 5.1,
 * Qwen3.5, GPT-OSS 20B, Devstral Small 2, and MiniMax M2.5.
 *
 * Display Configuration:
 *   Create ~/.pi/agent/extensions/neuralwatt.json to configure the footer display:
 *   {
 *     "energy": "widget",         // "widget" | "statusbar" | "off"
 *     "quota": "widget",          // "widget" | "statusbar" | "off"
 *     "mcr": "widget",            // "widget" | "statusbar" | "off"
 *     "carbon": "widget",         // "widget" | "statusbar" | "off"
 *     "hideOnOtherProvider": false  // hide display when a non-Neuralwatt model is active
 *   }
 *
 *   - "widget" (default): rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (for quota, also skips the API fetch)
 *   - hideOnOtherProvider: when true, auto-hide all Neuralwatt display if the
 *     active model's provider is not "neuralwatt". The display returns when you
 *     switch back to a Neuralwatt model. Default: false.
 *   - carbon: session CO₂ (🌱, energy line) + the fleet grid/region badge
 *     (quota line). The badge shows the latest request's electricity grid
 *     (e.g. 🇺🇸 PJM 416), compressing flag → intensity → BA tag as space
 *     tightens; a "~" marks intensities from a fallback carbon_source.
 *     Default: "widget".
 *
 * Neuralwatt Features:
 *   - OpenAI-compatible API (https://api.neuralwatt.com/v1)
 *   - Reasoning/thinking models
 *   - Vision models (Kimi K2.5)
 *   - Tool use support
 *   - Streaming support
 *   - Energy reporting per-request (Joules, kWh, watts, duration)
 *   - Request cost reporting (USD)
 *   - Carbon/grid reporting per-request (CO₂e, grid_id, grid intensity)
 *
 * @see https://neuralwatt.com
 */

import type { SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchesData from "./patch.json" with { type: "json" };
import { transformContextForImageLimit } from "./transform";
import fs from "fs";
import path from "path";

// ─── Display Configuration ────────────────────────────────────────────────────

type DisplayMode = "widget" | "statusbar" | "off";

interface NeuralwattConfig {
  energy: DisplayMode;
  quota: DisplayMode;
  mcr: DisplayMode;
  // Where carbon emissions (session CO₂) + the fleet grid/region badge are
  // shown. CO₂ augments the energy line; the grid badge augments the quota
  // line. "off" hides both. See README "Display Configuration".
  carbon: DisplayMode;
  // When true, hide energy/quota/MCR display if the active model's provider
  // is not "neuralwatt". Prevents stale display after switching providers.
  hideOnOtherProvider: boolean;
  // Per-model overrides applied ON TOP of patch.json + custom-models.json, keyed
  // by model id. Lets a user override compat flags (e.g. toggle
  // chat_template_kwargs) without editing the extension. Deep-merges `compat`
  // and `thinkingLevelMap`; replaces scalars. See README "Model Overrides".
  modelOverrides?: Record<string, ModelOverride>;
}

interface ModelOverride {
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, any>;
  vision?: { maxImagesPerRequest?: number };
}

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "neuralwatt.json");

const VALID_DISPLAY_MODES = new Set<string>(["widget", "statusbar", "off"]);

function parseDisplayMode(value: unknown, fallback: DisplayMode): DisplayMode {
  if (typeof value === "string" && VALID_DISPLAY_MODES.has(value)) return value as DisplayMode;
  return fallback;
}

const DEFAULT_CONFIG: NeuralwattConfig = { energy: "widget", quota: "widget", mcr: "widget", carbon: "widget", hideOnOtherProvider: false };

function loadConfig(): NeuralwattConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      energy: parseDisplayMode(raw.energy, "widget"),
      quota: parseDisplayMode(raw.quota, "widget"),
      mcr: parseDisplayMode(raw.mcr, "widget"),
      carbon: parseDisplayMode(raw.carbon, "widget"),
      hideOnOtherProvider: typeof raw.hideOnOtherProvider === "boolean" ? raw.hideOnOtherProvider : false,
      modelOverrides: parseModelOverrides(raw.modelOverrides),
    };
  } catch {
    // Config file missing or invalid — populate with defaults so the user can discover it
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    } catch {
      // Write failure is non-fatal — defaults still work in memory
    }
    return { ...DEFAULT_CONFIG };
  }
}

// Validate user-supplied modelOverrides from the config file. Non-object / non-string
// ids are dropped silently so a malformed file doesn't crash model registration.
function parseModelOverrides(raw: unknown): Record<string, ModelOverride> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, ModelOverride> = {};
  for (const [id, override] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== "string" || !override || typeof override !== "object" || Array.isArray(override)) continue;
    const o = override as Record<string, unknown>;
    const parsed: ModelOverride = {};
    if (o.thinkingLevelMap && typeof o.thinkingLevelMap === "object") {
      const m: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(o.thinkingLevelMap as Record<string, unknown>)) {
        if (v === null || typeof v === "string") m[k] = v;
      }
      if (Object.keys(m).length > 0) parsed.thinkingLevelMap = m;
    }
    if (o.compat && typeof o.compat === "object") parsed.compat = o.compat as Record<string, any>;
    if (o.vision && typeof o.vision === "object") parsed.vision = o.vision as { maxImagesPerRequest?: number };
    if (Object.keys(parsed).length > 0) result[id] = parsed;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

let config = loadConfig();

// Read-modify-write the raw config JSON without parsing/validating, so unknown
// fields a user added (or other modelOverride fields) survive a settings-UI write.
// `loadConfig()` (validated) is still called after writing to refresh the in-memory
// `config` the runtime uses.
function readRawNeuralwattConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeRawNeuralwattConfig(raw: Record<string, any>): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
  } catch {
    // Write failure is non-fatal — the in-memory refresh still applies.
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

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
  thinkingLevelMap?: {
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
  };
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    // Raw chat_template_kwargs merged into every chat-completions request via
    // pi-ai's onPayload hook. Mirrors vLLM's request field of the same name; the
    // values are template-level flags the model's Jinja chat template reads, so
    // they're model-family-specific (NOT a generic boolean). Injected alongside
    // reasoning_effort (not via thinkingFormat: "chat-template" — that branch is
    // mutually exclusive with the openai reasoning_effort path). Behavioral E2E:
    //   Kimi K2.6/K2.7  → { "preserve_thinking": true }   (template keeps full reasoning history across turns)
    //   GLM-5.x family  → { "clear_thinking": false }     (template stops clearing older assistant reasoning)
    // GLM-5.1 / Qwen3.x expose no family-wide flag; Layer-A replay (the `reasoning`
    // field, aliased reasoning <-> reasoning_content by the gateway) still applies to all.
    chatTemplateKwargs?: Record<string, string | number | boolean | null>;
  };
  vision?: {
    maxImagesPerRequest?: number;
  };
}

// ─── Patch & Custom Model Merging ─────────────────────────────────────────────

function applyPatch(model: NeuralwattModel, patch: Record<string, any>): NeuralwattModel {
  const result = { ...model };
  const NESTED_KEYS = new Set(["compat", "vision", "cost"]);
  for (const [key, value] of Object.entries(patch)) {
    if (NESTED_KEYS.has(key) && typeof value === "object" && value !== null && typeof (result as any)[key] === "object") {
      (result as any)[key] = { ...(result as any)[key], ...value };
    } else {
      (result as any)[key] = value;
    }
  }
  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }
  return result;
}

// Apply a user-supplied modelOverride (from neuralwatt.json) on top of a built
// model. Same deep-merge semantics as applyPatch for compat/vision/cost, plus
// thinkingLevelMap (so a user can override a single thinking level without
// redeclaring the whole map). Scalars are replaced. No reasoning-cleanup
// (unlike applyPatch) — the user's override is authoritative.
function applyModelOverride(model: NeuralwattModel, override: ModelOverride): NeuralwattModel {
  const result = { ...model };
  const NESTED_KEYS = new Set(["compat", "vision", "cost", "thinkingLevelMap"]);
  for (const [key, value] of Object.entries(override)) {
    if (NESTED_KEYS.has(key) && typeof value === "object" && value !== null && typeof (result as any)[key] === "object") {
      (result as any)[key] = { ...(result as any)[key], ...value };
    } else {
      (result as any)[key] = value;
    }
  }
  return result;
}

/** Full pipeline: base → patch → custom → user modelOverrides → result */
function buildModels(
  base: NeuralwattModel[],
  custom: NeuralwattModel[],
  patchList: Record<string, any>,
  overrides: Record<string, ModelOverride> = {},
): NeuralwattModel[] {
  const modelMap = new Map<string, NeuralwattModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patchList)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchList[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  // User-supplied modelOverrides (from ~/.pi/agent/extensions/neuralwatt.json)
  // applied LAST so they win over patch.json + custom-models.json. Deep-merges
  // compat / thinkingLevelMap / vision so a user can toggle a single flag
  // (e.g. chatTemplateKwargs.preserve_thinking) without redeclaring the rest.
  for (const [id, override] of Object.entries(overrides)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyModelOverride(existing, override));
    }
  }

  return Array.from(modelMap.values()).map((model) => {
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
    if (model.thinkingLevelMap) {
      result.thinkingLevelMap = model.thinkingLevelMap;
    }
    if (model.compat) {
      result.compat = model.compat;
    }
    if (model.vision) {
      result.vision = model.vision;
    }
    return result;
  });
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "neuralwatt";
export const BASE_URL = "https://api.neuralwatt.com/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/** Transform a model from the Neuralwatt /v1/models API using metadata. */
function transformApiModel(apiModel: any): NeuralwattModel | null {
  const meta = apiModel.metadata || {};
  const pricing = meta.pricing || {};
  const caps = meta.capabilities || {};
  const limits = meta.limits || {};

  const hasVision = caps.vision === true;
  const hasReasoning = caps.reasoning === true;

  const inputTypes: ("text" | "image")[] = ["text"];
  if (hasVision) {
    inputTypes.push("image");
  }

  const contextWindow = limits.max_context_length || apiModel.max_model_len || 131072;
  const maxTokens = limits.max_output_tokens || contextWindow;

  const model: NeuralwattModel = {
    id: apiModel.id,
    name: meta.display_name || apiModel.id,
    reasoning: hasReasoning,
    input: inputTypes,
    cost: {
      input: pricing.input_per_million ?? 0,
      output: pricing.output_per_million ?? 0,
      cacheRead: pricing.cached_input_per_million ?? 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens,
  };

  const compat: NeuralwattModel["compat"] = {};
  if (caps.developer_role === false) {
    compat.supportsDeveloperRole = false;
  }
  if (caps.reasoning_effort === true) {
    compat.supportsReasoningEffort = true;
  }
  if (Object.keys(compat).length > 0) {
    model.compat = compat;
  }

  if (hasVision && limits.max_images != null) {
    model.vision = { maxImagesPerRequest: limits.max_images };
  }

  return model;
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<NeuralwattModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is NeuralwattModel => m !== null);
  } catch {
    return null;
  }
}

function loadCachedModels(): NeuralwattModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: NeuralwattModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: NeuralwattModel[], embeddedModels: NeuralwattModel[]): NeuralwattModel[] {
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: NeuralwattModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0) so curated cacheRead/cacheWrite isn't clobbered and
      // providers whose /models endpoint exposes no pricing keep their curated
      // cost. Curation (reasoning/input/compat/name) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: NeuralwattModel[]): NeuralwattModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: NeuralwattModel[], signal?: AbortSignal): Promise<NeuralwattModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("neuralwatt") ?? undefined;
}

// ─── Session State (event-sourced via pi.appendEntry) ─────────────────────────

interface EnergyEvent {
  energy_joules: number;
  cost_usd: number;
  // Raw SSE comment payloads, stored verbatim. These are the source of
  // truth for MCR replay — future upstream fields flow through without
  // code changes. Not used for energy/cost replay (those are cumulative
  // sums from the explicit fields above).
  sse_energy_raw?: Record<string, unknown>;
  sse_mcr_session_raw?: Record<string, unknown>;
  sse_cost_raw?: Record<string, unknown>;
}

const ENERGY_ENTRY_TYPE = "neuralwatt-energy";
const STATUS_KEY_ENERGY = "neuralwatt-energy";
const STATUS_KEY_QUOTA = "neuralwatt-quota";
const STATUS_KEY_MCR = "neuralwatt-mcr";

let sessionEnergyJoules = 0;
let sessionCostUsd = 0;
let sessionMcrFp: string | null = null;
let sessionSafeDropBefore = 0;
let sessionApcHitRate: number | undefined;
let sessionCompactRatio: number | undefined;
// Carbon/grid (from sse_energy_raw). Carbon is cumulative (like energy);
// grid_id/intensity/carbon_source are latest-wins (like MCR fp) — the fleet
// routes per-request, so the most recent request's grid is the "current" one.
let sessionCarbonGrams = 0;
let sessionGridId: string | null = null;
let sessionGridIntensity: number | undefined;
let sessionGridCarbonSource: string | undefined;
let pendingEnergyJoules = 0;
let pendingCostUsd = 0;
let pendingEnergyRaw: Record<string, unknown> | null = null;
let pendingMcrSessionRaw: Record<string, unknown> | null = null;
let pendingCostRaw: Record<string, unknown> | null = null;
let teeReader: Promise<void> | undefined;

// Shared bridge for raw SSE comment payloads parsed from the stream tee.
// Uses globalThis so the neuralwatt-mcr.ts extension (a separate ESM
// module loaded by Pi) can consume the data regardless of whether Pi
// shares the same module instance for index.ts. If two import() calls
// resolve to different module instances, module-level variables are
// NOT shared — but globalThis always is (same JS process). Index.ts
// publishes to the bridge in its turn_end handler after awaiting the
// tee reader; neuralwatt-mcr.ts consumes from the bridge in its own
// turn_end handler.
const NW_MCR_BRIDGE = Symbol.for("pi-neuralwatt-provider.mcr-bridge");

interface NWMCRRidge {
  energyRaw: Record<string, unknown> | null;
  mcrSessionRaw: Record<string, unknown> | null;
  costRaw: Record<string, unknown> | null;
}

function getMCRRidge(): NWMCRRidge {
  if (!(globalThis as any)[NW_MCR_BRIDGE]) {
    (globalThis as any)[NW_MCR_BRIDGE] = { energyRaw: null, mcrSessionRaw: null, costRaw: null };
  }
  return (globalThis as any)[NW_MCR_BRIDGE];
}

export function publishMCRRidge(): void {
  const bridge = getMCRRidge();
  bridge.energyRaw = pendingEnergyRaw;
  bridge.mcrSessionRaw = pendingMcrSessionRaw;
  bridge.costRaw = pendingCostRaw;
}

export function consumePendingMCR(): NWMCRRidge {
  const bridge = getMCRRidge();
  const result = {
    energyRaw: bridge.energyRaw,
    mcrSessionRaw: bridge.mcrSessionRaw,
    costRaw: bridge.costRaw,
  };
  bridge.energyRaw = null;
  bridge.mcrSessionRaw = null;
  bridge.costRaw = null;
  return result;
}

// Exposed for testing
export function getPendingState() {
  return { pendingEnergyJoules, pendingCostUsd, teeReader, pendingEnergyRaw, pendingMcrSessionRaw, pendingCostRaw };
}

export function resetSessionState() {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  sessionMcrFp = null;
  sessionSafeDropBefore = 0;
  sessionApcHitRate = undefined;
  sessionCompactRatio = undefined;
  sessionCarbonGrams = 0;
  sessionGridId = null;
  sessionGridIntensity = undefined;
  sessionGridCarbonSource = undefined;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
  pendingEnergyRaw = null;
  pendingMcrSessionRaw = null;
  pendingCostRaw = null;
  // Also clear the bridge so stale data doesn't leak across tests
  const bridge = (globalThis as any)[NW_MCR_BRIDGE];
  if (bridge) {
    bridge.energyRaw = null;
    bridge.mcrSessionRaw = null;
    bridge.costRaw = null;
  }
}

function replayEnergyEvents(ctx: any): void {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  sessionMcrFp = null;
  sessionSafeDropBefore = 0;
  sessionApcHitRate = undefined;
  sessionCompactRatio = undefined;
  sessionCarbonGrams = 0;
  sessionGridId = null;
  sessionGridIntensity = undefined;
  sessionGridCarbonSource = undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENERGY_ENTRY_TYPE && entry.data) {
      sessionEnergyJoules += entry.data.energy_joules || 0;
      sessionCostUsd += entry.data.cost_usd || 0;
      // MCR state from raw SSE payloads (latest-wins, not cumulative).
      // Reads from the verbatim payloads so new upstream MCR fields
      // automatically flow through without interface or code changes.
      const mcrSession = entry.data.sse_mcr_session_raw as Record<string, unknown> | undefined;
      if (mcrSession && typeof mcrSession.session_fp === "string") {
        sessionMcrFp = mcrSession.session_fp;
        sessionSafeDropBefore =
          typeof mcrSession.safe_drop_before === "number"
            ? mcrSession.safe_drop_before
            : 0;
      }
      const energyRaw = entry.data.sse_energy_raw as Record<string, unknown> | undefined;
      if (energyRaw) {
        const mcr = energyRaw.mcr as Record<string, unknown> | undefined;
        if (mcr && typeof mcr === "object") {
          if (typeof mcr.apc_hit_rate === "number") sessionApcHitRate = mcr.apc_hit_rate;
          if (typeof mcr.mcr_compacted_tokens === "number" && typeof mcr.mcr_original_tokens === "number") {
            sessionCompactRatio = mcr.mcr_compacted_tokens / mcr.mcr_original_tokens;
          }
        }
        // Carbon (cumulative) + grid (latest-wins) from the verbatim payload.
        const co2 = energyRaw.carbon_g_co2eq;
        if (typeof co2 === "number") sessionCarbonGrams += co2;
        const gid = energyRaw.grid_id;
        if (typeof gid === "string") sessionGridId = gid;
        const gi = energyRaw.grid_carbon_intensity_gco2perkwhr;
        if (typeof gi === "number") sessionGridIntensity = gi;
        const csrc = energyRaw.carbon_source;
        if (typeof csrc === "string") sessionGridCarbonSource = csrc;
      }
    }
  }
}

// Progressive-disclosure energy text. Returns the highest-fidelity string that
// fits within maxCols visible columns, or undefined if nothing meaningful fits.
//
// Levels (each progressively more compressed):
//   ⚡0.77 mWh $0.003829   full: value (spaced unit) + cost
//   ⚡0.77mWh $0.003829    compressed: value (merged unit) + cost
//   ⚡0.77mWh              compressed value only (cost dropped)
// Progressive-disclosure energy + MCR text. Returns the highest-fidelity
// string that fits within maxCols visible columns, or undefined if nothing
// meaningful fits.
//
// MCR parts are appended after energy and are progressively dropped (compact
// → APC → drop → fp) before energy itself compresses. This keeps energy
// visible even when MCR detail doesn't fit.
//
// Levels (most → least detail), with carbon (🌱 session CO₂) inserted between
// cost and MCR — carbon is more core than MCR detail, so MCR drops first, then
// the "CO₂" suffix, then the carbon value (compact), then energy compresses:
//   ⚡0.77 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5 APC 85% compact 45%
//   ⚡0.77 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5 APC 85%
//   ⚡0.77 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5
//   ⚡0.77 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0
//   ⚡0.77 mWh $0.003829 🌱1.24 g CO₂
//   ⚡0.77 mWh $0.003829 🌱1.24 g                          drop "CO₂" suffix
//   ⚡0.77 mWh $0.003829 🌱1.24g                          compact carbon
//   ⚡0.77 mWh $0.003829                                 drop carbon
//   ⚡0.77mWh $0.003829                                 compressed + cost
//   ⚡0.77mWh                                            compressed only
function buildEnergyText(maxCols: number): string | undefined {
  const hasEnergy = sessionEnergyJoules > 0 || sessionCostUsd > 0;
  const hasMCR = config.mcr !== "off" && sessionMcrFp !== null;
  const hasCarbon = config.carbon !== "off" && sessionCarbonGrams > 0;

  if (!hasEnergy && !hasMCR) return undefined;

  // Energy string levels
  const energyStr = formatEnergy(sessionEnergyJoules);
  const costStr = formatCost(sessionCostUsd);
  const compactStr = formatEnergyCompact(sessionEnergyJoules);
  const coreFull = `⚡${energyStr} ${costStr}`;
  const coreCompressedCost = `⚡${compactStr} ${costStr}`;
  const coreCompressedOnly = `⚡${compactStr}`;

  // MCR parts in priority order (least important dropped first)
  // compact → APC → drop< → fp → "MCR" prefix
  const mcrParts: string[] = [];
  if (sessionMcrFp) mcrParts.push(`MCR ${sessionMcrFp.slice(0, 8)}`);
  if (sessionSafeDropBefore > 0) mcrParts.push(`drop<${sessionSafeDropBefore}`);
  if (sessionApcHitRate !== undefined) mcrParts.push(`APC ${(sessionApcHitRate * 100).toFixed(0)}%`);
  if (sessionCompactRatio !== undefined) mcrParts.push(`compact ${(sessionCompactRatio * 100).toFixed(0)}%`);

  // MCR tiers: full join → drop parts from the end → "" (MCR dropped). Carbon
  // (below) is more core than MCR detail, so MCR drops before carbon does.
  const mcrTiers: string[] = [];
  if (hasMCR) {
    mcrTiers.push(mcrParts.join(" "));
    for (let drop = 1; drop <= mcrParts.length; drop++) {
      const t = mcrParts.slice(0, mcrParts.length - drop).join(" ");
      if (t !== mcrTiers[mcrTiers.length - 1]) mcrTiers.push(t);
    }
    if (mcrTiers[mcrTiers.length - 1] !== "") mcrTiers.push("");
  } else {
    mcrTiers.push("");
  }

  // Carbon tiers: "🌱X g CO₂" → "🌱X g" → "🌱Xg" → "" (dropped).
  const carbonTiers: string[] = [];
  if (hasCarbon) {
    const carbonStr = formatCarbon(sessionCarbonGrams);
    const carbonCompact = formatCarbonCompact(sessionCarbonGrams);
    carbonTiers.push(`🌱${carbonStr} CO₂`, `🌱${carbonStr}`, `🌱${carbonCompact}`, "");
  } else {
    carbonTiers.push("");
  }

  // left = energy core + (carbon segment if any). Single space: carbon is part
  // of the energy core, not a separate panel like MCR (which uses two spaces).
  const leftWith = (carbonText: string) => (carbonText ? `${coreFull} ${carbonText}` : coreFull);

  const candidates: string[] = [];
  const carbonFull = carbonTiers[0];

  if (hasEnergy) {
    // Phase 1: drop MCR parts (carbon full, core full).
    for (const mcrText of mcrTiers) {
      const left = leftWith(carbonFull);
      const c = mcrText ? `${left}  ${mcrText}` : left;
      if (c !== candidates[candidates.length - 1]) candidates.push(c);
    }
    // Phase 2: MCR dropped — drop carbon tiers (core full).
    for (const carbonText of carbonTiers.slice(1)) {
      const c = leftWith(carbonText);
      if (c !== candidates[candidates.length - 1]) candidates.push(c);
    }
    // Phase 3: compress energy core (carbon & MCR dropped).
    if (candidates[candidates.length - 1] !== coreCompressedCost) candidates.push(coreCompressedCost);
    if (candidates[candidates.length - 1] !== coreCompressedOnly) candidates.push(coreCompressedOnly);
  } else {
    // MCR only, no energy (and thus no carbon — carbon requires energy).
    candidates.push(mcrParts.join(" "));
    for (let drop = 1; drop < mcrParts.length; drop++) {
      candidates.push(mcrParts.slice(0, mcrParts.length - drop).join(" "));
    }
    candidates.push(mcrParts[0]);
  }

  for (const text of candidates) {
    if (termVisWidth(text) <= maxCols) return text;
  }

  // Nothing fits — truncate the most compressed form
  return truncateAnsi(candidates[candidates.length - 1], maxCols);
}

// Compact energy format: merges value and unit with no space ("0.77mWh" vs "0.77 mWh").
function formatEnergyCompact(joules: number): string {
  if (joules === 0) return "0J";
  if (joules < 3.6) {
    return `${joules.toFixed(2)}J`;
  }
  const mwh = joules / 3600;
  if (mwh < 1000) {
    return `${mwh.toFixed(2)}mWh`;
  }
  const wh = mwh / 1000;
  if (wh < 1000) {
    return `${wh.toFixed(2)}Wh`;
  }
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)}kWh`;
}

// ─── Grid / Carbon Display ─────────────────────────────────────────────────────
// Neuralwatt's per-request energy payload carries the electricity grid the GPU
// node drew from (grid_id), that grid's carbon intensity, and the resulting
// CO₂e. The fleet routes across multiple grids (FI, FR, US-CAL-CISO,
// US-CAR-DUK, US-MIDA-PJM, …), so grid_id is latest-wins (the "current" grid)
// while session CO₂ accumulates like energy.
//
// grid_id is either a bare ISO country code ("FI") or an EIA/Electricity-Maps
// style "CC-SUBREGION-BA" code ("US-MIDA-PJM"). We parse it generically (no
// hardcoded list): the country comes from the first segment, the flag from
// the country code via regional indicator symbols, and the short tag from
// the last segment (the balancing-authority id). Any new grid Neuralwatt
// routes to is handled without a code change.

interface GridDisplay {
  country: string | null;
  flag: string;
  short: string;
  name: string;
}

// Build a flag emoji from any 2-letter ISO country code using regional indicator
// symbols (0x1F1E6 + letter offset). Returns "" for non-2-letter codes so the
// badge degrades to text-only for unknown grids.
function countryFlag(cc: string | null): string {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return "";
  const a = cc.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + a.charCodeAt(0) - 65, 0x1f1e6 + a.charCodeAt(1) - 65);
}

export function parseGridId(gridId: string): GridDisplay {
  const parts = gridId.split("-");
  if (parts.length === 1) {
    // bare country code (e.g. "FI", "FR")
    return { country: gridId, flag: countryFlag(gridId), short: gridId, name: gridId };
  }
  // "CC-SUBREGION-BA" (e.g. "US-MIDA-PJM"): country = first segment,
  // short = last segment (the balancing-authority id).
  const country = parts[0];
  const short = parts[parts.length - 1];
  return { country, flag: countryFlag(country), short, name: gridId };
}

// Carbon (CO₂e) tiered formatting, mirroring formatEnergy's tiers.
export function formatCarbon(grams: number): string {
  if (grams === 0) return "0 g";
  if (grams < 1) return `${(grams * 1000).toFixed(2)} mg`;
  if (grams < 1000) {
    const dec = grams < 10 ? 2 : grams < 100 ? 1 : 0;
    return `${grams.toFixed(dec)} g`;
  }
  return `${(grams / 1000).toFixed(2)} kg`;
}

export function formatCarbonCompact(grams: number): string {
  if (grams === 0) return "0g";
  if (grams < 1) return `${(grams * 1000).toFixed(2)}mg`;
  if (grams < 1000) {
    const dec = grams < 10 ? 2 : grams < 100 ? 1 : 0;
    return `${grams.toFixed(dec)}g`;
  }
  return `${(grams / 1000).toFixed(2)}kg`;
}

// Region badge tiers (most → least detailed). The flag drops first (decorative
// and the widest per-info), then the intensity, leaving the balancing-authority
// short tag as the width-safe text survivor that distinguishes same-country
// grids (PJM vs CISO vs DUK). A "~" suffix marks intensities from a fallback
// carbon_source (regional_fallback / static_fallback), since those are
// approximate rather than measured.
function buildRegionTiers(): string[] {
  if (config.carbon === "off" || !sessionGridId) return [""];
  const g = parseGridId(sessionGridId);
  const fallback =
    sessionGridCarbonSource === "regional_fallback" || sessionGridCarbonSource === "static_fallback";
  const intensity =
    sessionGridIntensity != null ? `${Math.round(sessionGridIntensity)}${fallback ? "~" : ""}` : "";
  const t1 = [g.flag, g.short, intensity].filter(Boolean).join(" ");
  const t2 = [g.short, intensity].filter(Boolean).join(" ");
  const t3 = g.short;
  const tiers = [t1, t2, t3, ""];
  return tiers.filter((t, i) => i === 0 || t !== tiers[i - 1]);
}

// ─── Quota Fetching ──────────────────────────────────────────────────────────

interface QuotaResponse {
  snapshot_at: string;
  balance: {
    credits_remaining_usd: number;
    total_credits_usd: number;
    credits_used_usd: number;
    accounting_method: string;
  };
  usage: {
    lifetime: { cost_usd: number; requests: number; tokens: number; energy_kwh: number };
    current_month: { cost_usd: number; requests: number; tokens: number; energy_kwh: number };
  };
  limits: {
    overage_limit_usd: number | null;
    rate_limit_tier: string;
  };
  subscription: {
    plan: string;
    status: string;
    billing_interval: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    auto_renew: boolean | null;
    kwh_included: number | null;
    kwh_used: number | null;
    kwh_remaining: number | null;
    in_overage: boolean | null;
  } | null;
  key: {
    name: string | null;
    allowance: {
      limit_usd: number;
      period: string;
      spent_usd: number;
      remaining_usd: number;
      blocked: boolean;
    } | null;
  };
}

let cachedQuota: QuotaResponse | null = null;

async function fetchQuota(apiKey: string, signal?: AbortSignal): Promise<QuotaResponse | null> {
  try {
    const response = await fetch(`${BASE_URL}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as QuotaResponse;
  } catch {
    return null;
  }
}

// Progressive-disclosure quota text. Returns the highest-fidelity string
// that fits within maxCols visible columns, or undefined if nothing fits.
//
// Quota levels drop less-important detail and compress formatting. When
// carbon is on, the fleet grid/region badge is appended and is more important
// than quota detail, so quota compresses first (badge held at full), then the
// badge itself compresses (flag → intensity → short tag → dropped) while the
// quota is at its plan-only minimum:
//
//   pro ● 28.0/33.0 kWh ∙ $74.62 ∙ ⚷ $0.12/$1.00/d 🇺🇸 PJM 416   full
//   pro ● 28.0/33.0 kWh ∙ $74.62 🇺🇸 PJM 416                   drop allowance
//   pro ● 28.0/33.0kWh ∙ $74.62 🇺🇸 PJM 416                   merge kWh unit
//   pro ● 28.0kWh ∙ $74.62 🇺🇸 PJM 416                        drop "/total"
//   pro ● ∙ $74.62 🇺🇸 PJM 416                               drop kWh
//   pro ∙ $74.62 🇺🇸 PJM 416                                 drop status dot
//   pro 🇺🇸 PJM 416                                           plan only + badge
//   pro PJM 416                                             drop flag
//   pro PJM                                                drop intensity
//   pro                                                   drop badge
// Combine quota tiers with region-badge tiers. Quota detail drops first
// (badge held full), then the badge compresses while the quota is at its
// minimum. When there is no grid (carbon off or no data yet) regionTiers is
// [""], which makes this a passthrough over the quota tiers.
function combineQuotaRegion(quotaTiers: string[], regionTiers: string[], maxCols: number): string {
  const regionFull = regionTiers[0];
  const last = quotaTiers[quotaTiers.length - 1];
  const candidates: string[] = [];
  for (const qt of quotaTiers) {
    const c = regionFull ? `${qt} ${regionFull}` : qt;
    if (c !== candidates[candidates.length - 1]) candidates.push(c);
  }
  for (const rt of regionTiers.slice(1)) {
    const c = rt ? `${last} ${rt}` : last;
    if (c !== candidates[candidates.length - 1]) candidates.push(c);
  }
  for (const text of candidates) {
    if (termVisWidth(text) <= maxCols) return text;
  }
  return truncateAnsi(last, maxCols);
}

// Region badge as a standalone (quota-side) text, compressed to fit maxCols.
// Used when the quota line is off but carbon is on, so the fleet grid/region
// badge still renders on its own (latest-wins grid + intensity).
function buildRegionText(maxCols: number): string | undefined {
  const tiers = buildRegionTiers();
  for (const t of tiers) {
    if (t && termVisWidth(t) <= maxCols) return t;
  }
  return undefined; // only "" fits (or no grid) — don't render
}

function buildQuotaText(maxCols: number): string | undefined {
  if (!cachedQuota) return undefined;
  const q = cachedQuota;
  const regionTiers = buildRegionTiers();

  if (q.subscription) {
    const plan = q.subscription.plan;
    const active = q.subscription.status === "active";
    const pastDue = q.subscription.status === "past_due" || q.subscription.status === "paused";
    const kwhIncl = q.subscription.kwh_included;
    const kwhRem = q.subscription.kwh_remaining;
    const hasKwh = kwhIncl != null && kwhRem != null;
    const credits = formatCost(q.balance.credits_remaining_usd);
    const overage = q.subscription.in_overage === true;
    const allowance = buildAllowancePart(q);

    // Quota tiers from most to least detailed
    const quotaTiers: string[] = [];
    quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, hasKwh, kwhRem, kwhIncl, overage, true, true, credits, allowance));
    if (allowance) quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, hasKwh, kwhRem, kwhIncl, overage, true, true, credits));
    if (hasKwh) quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, true, kwhRem, kwhIncl, overage, false, true, credits));
    if (hasKwh) quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, true, kwhRem, null, overage, false, true, credits));
    quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, false, null, null, overage, false, true, credits));
    quotaTiers.push(buildQuotaSubParts(plan, active, pastDue, false, null, null, overage, false, false, credits));
    quotaTiers.push(plan);

    return combineQuotaRegion(quotaTiers, regionTiers, maxCols);
  } else {
    // Pay-as-you-go: no subscription
    const credits = formatCost(q.balance.credits_remaining_usd);
    const allowance = buildAllowancePart(q);

    const quotaTiers: string[] = [];
    quotaTiers.push(["payg", `∙ ${credits}`, allowance].filter(Boolean).join(" "));
    quotaTiers.push(["payg", `∙ ${credits}`].join(" "));
    quotaTiers.push("payg");

    return combineQuotaRegion(quotaTiers, regionTiers, maxCols);
  }
}

function buildAllowancePart(q: QuotaResponse): string | undefined {
  if (!q.key.allowance) return undefined;
  const a = q.key.allowance;
  const spent = a.limit_usd - a.remaining_usd;
  const periodLabel = { daily: "d", weekly: "wk", monthly: "mo" }[a.period] ?? a.period;
  let part = `∙ ⚷ ${formatCost(spent)}/${formatCost(a.limit_usd)}/${periodLabel}`;
  if (a.blocked) part += " ⊘";
  return part;
}

// Assembles subscription quota parts into a display string.
// showDot: include the ● status indicator
// spacedKwhUnit: "28.0/33.0 kWh" vs "28.0/33.0kWh"
// kwhTotal: if provided, shows "remaining/total"; if null, shows "remaining" only
function buildQuotaSubParts(
  plan: string,
  active: boolean,
  pastDue: boolean,
  showKwh: boolean,
  kwhRem: number | null,
  kwhTotal: number | null,
  overage: boolean,
  spacedKwhUnit: boolean,
  showDot: boolean,
  credits: string,
  allowance?: string,
): string {
  const parts: string[] = [];
  parts.push(plan);
  if (showDot) {
    if (active) {
      parts.push("●");
    } else if (pastDue) {
      parts.push("⊘");
    }
  }
  if (showKwh && kwhRem != null) {
    if (kwhTotal != null) {
      const unit = spacedKwhUnit ? " kWh" : "kWh";
      parts.push(`${formatKwh(kwhRem)}/${formatKwh(kwhTotal)}${unit}`);
    } else {
      parts.push(`${formatKwh(kwhRem)}kWh`);
    }
    if (overage) parts.push("⚠");
    parts.push(`∙ ${credits}`);
  } else if (!showDot || pastDue) {
    // No kWh and either no status dot or error dot — need ∙ separator before credits
    parts.push(`∙ ${credits}`);
  } else {
    // ● already acts as visual delimiter — skip ∙
    parts.push(credits);
  }
  if (allowance) parts.push(allowance);
  return parts.join(" ");
}

function formatKwh(kwh: number): string {
  if (kwh === 0) return "0";
  if (kwh < 0.01) return kwh.toFixed(4);
  if (kwh < 1) return kwh.toFixed(2);
  if (kwh < 100) return kwh.toFixed(1);
  return Math.round(kwh).toString();
}

// Terminal-visible column width. Accounts for:
// - ANSI escape sequences (0 cols)
// - Emoji like ⚡ (2 cols)
// - Ambiguous-width chars that this terminal renders as 2 cols
// - All other visible chars (1 col)
const EMOJI_RE = /\p{Emoji_Presentation}/u;
const AMBIGUOUS_WIDE = new Set(["◆", "■", "▲", "◉"]);

function termVisWidth(str: string): number {
  let width = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);
    // ANSI escape
    if (code === 0x1b && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next === 0x5b) { // CSI: \x1b[
        i += 2;
        while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
        while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
        if (i < str.length) i++;
        continue;
      }
    }
    // Advance by code point so non-BMP chars (flag emoji, 🌱) are measured as
    // one glyph, not split into two 1-col surrogate halves. Regional indicators
    // (U+1F1E6–U+1F1FF) are Emoji_Presentation individually but combine into a
    // single 2-col flag, so count each as 1 col (a flag pair = 2, not 4).
    const cp = str.codePointAt(i)!;
    const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      width += 1;
    } else if (EMOJI_RE.test(char)) {
      width += 2;
    } else if (AMBIGUOUS_WIDE.has(char)) {
      width += 2;
    } else {
      width += 1;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

// Truncate a string (which may contain ANSI escape sequences or wide chars)
// to fit within maxCols visible columns. Appends "…" if truncation occurs.
function truncateAnsi(str: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (termVisWidth(str) <= maxCols) return str;

  // Walk the string tracking visible width. When adding the next character
  // would exceed maxCols - 1 (reserving 1 for "…"), cut and append "…".
  let result = "";
  let visWidth = 0;
  let i = 0;
  const ellipsisCols = 1; // "…" is 1 visible col
  const target = maxCols - ellipsisCols;

  while (i < str.length) {
    const code = str.charCodeAt(i);

    // ANSI escape — always preserved (0 visible width)
    if (code === 0x1b && i + 1 < str.length && str.charCodeAt(i + 1) === 0x5b) {
      const start = i;
      i += 2;
      while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
      while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
      if (i < str.length) i++;
      result += str.slice(start, i);
      continue;
    }

    // Determine the visible width of this code point (advance by code point so
    // we never split a non-BMP char like a flag emoji or 🌱 mid-glyph). Regional
    // indicators combine into a 2-col flag, so each counts as 1 (a pair = 2).
    const cp = str.codePointAt(i)!;
    const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
    let charWidth: number;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      charWidth = 1;
    } else if (EMOJI_RE.test(char)) {
      charWidth = 2;
    } else if (AMBIGUOUS_WIDE.has(char)) {
      charWidth = 2;
    } else {
      charWidth = 1;
    }

    if (visWidth + charWidth > target) break;
    result += char;
    visWidth += charWidth;
    i += cp > 0xffff ? 2 : 1;
  }

  return result + "…";
}

// Custom Component that renders our status line with width-aware progressive
// disclosure. Left (energy) is always preserved at full fidelity; right (quota)
// compresses to fit the remaining space. If left alone exceeds width, it's
// truncated as a last resort to prevent overflow crashes.
//
// Stores raw (unthemed) text. Theme is applied inside render() so that
// progressive-disclosure recompression of the quota side uses raw text widths.
class StatusLineWidget {
  private leftRaw: string;
  private rightRaw: string | undefined;
  private compressRight: ((budget: number) => string | undefined) | undefined;
  private theme: any;

  constructor(theme: any, leftRaw: string, rightRaw?: string, compressRight?: (budget: number) => string | undefined) {
    this.theme = theme;
    this.leftRaw = leftRaw;
    this.rightRaw = rightRaw;
    this.compressRight = compressRight;
  }

  render(width: number): string[] {
    const leftVis = termVisWidth(this.leftRaw);

    // Safety net: if left alone exceeds width, truncate it
    if (leftVis > width) {
      return [this.theme.fg("dim", truncateAnsi(this.leftRaw, width))];
    }

    if (!this.rightRaw) {
      // Left only: theme + pad to width
      const themed = this.theme.fg("dim", this.leftRaw);
      const pad = width - termVisWidth(themed);
      return [themed + " ".repeat(Math.max(0, pad))];
    }

    const rightVis = termVisWidth(this.rightRaw);
    const available = width - leftVis;

    if (rightVis <= available - 1) {
      // Both fit with at least 1 space between
      const themedL = this.theme.fg("dim", this.leftRaw);
      const themedR = this.theme.fg("dim", this.rightRaw);
      const pad = width - termVisWidth(themedL) - termVisWidth(themedR);
      return [themedL + " ".repeat(Math.max(1, pad)) + themedR];
    }

    // Right doesn't fit at full fidelity — progressive compression.
    // buildQuotaText(budget) internally tries all levels and returns the
    // highest-fidelity string that fits within budget cols.
    const budget = available - 1;
    if (budget > 0) {
      const compressed = (this.compressRight ?? buildQuotaText)(budget);
      if (compressed) {
        const themedL = this.theme.fg("dim", this.leftRaw);
        const themedR = this.theme.fg("dim", compressed);
        const pad = width - termVisWidth(themedL) - termVisWidth(themedR);
        return [themedL + " ".repeat(Math.max(1, pad)) + themedR];
      }
    }

    // Nothing from quota fits — left only, themed + padded
    const themed = this.theme.fg("dim", this.leftRaw);
    const pad = width - termVisWidth(themed);
    return [themed + " ".repeat(Math.max(0, pad))];
  }
}

function updateEnergyStatus(ctx: any): void {
  // Show the status line only after neuralwatt activity is recorded in this
  // session. This avoids showing quota/energy data in sessions that use a
  // different provider, and prevents the quota from appearing before any
  // turn has completed (quota is pre-fetched eagerly so it's ready to display
  // as soon as the first turn ends, alongside the energy data).
  const hasNeuralwattSession = sessionEnergyJoules > 0 || sessionCostUsd > 0 || sessionMcrFp !== null || sessionCarbonGrams > 0 || sessionGridId !== null;

  // When hideOnOtherProvider is enabled, suppress display if the active
  // model is from a different provider. This prevents stale energy/quota
  // info from persisting after the user switches to a non-Neuralwatt model.
  // Use a try/catch because ctx.model is a getter that throws on stale contexts.
  let currentProvider: string | undefined;
  try {
    currentProvider = (ctx.model as any)?.provider as string | undefined;
  } catch {
    currentProvider = undefined;
  }
  const hiddenByOtherProvider = config.hideOnOtherProvider && currentProvider !== undefined && currentProvider !== PROVIDER_ID;

  // When hideOnOtherProvider suppresses display, clear everything.
  if (hiddenByOtherProvider) {
    ctx.ui.setStatus(STATUS_KEY_ENERGY, undefined);
    ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
    ctx.ui.setStatus(STATUS_KEY_MCR, undefined);
    ctx.ui.setWidget("neuralwatt", undefined);
    return;
  }

  // Statusbar uses full-fidelity text (no width constraint)
  // MCR is embedded in the energy text when config.mcr is "widget";
  // for statusbar mode, MCR gets its own status key.
  const energyFull = hasNeuralwattSession ? buildEnergyText(Infinity) : undefined;
  const mcrFull = hasNeuralwattSession && config.mcr === "statusbar" && sessionMcrFp
    ? [`MCR ${sessionMcrFp.slice(0, 8)}`, sessionSafeDropBefore > 0 ? `drop<${sessionSafeDropBefore}` : undefined, sessionApcHitRate !== undefined ? `APC ${(sessionApcHitRate * 100).toFixed(0)}%` : undefined, sessionCompactRatio !== undefined ? `compact ${(sessionCompactRatio * 100).toFixed(0)}%` : undefined].filter(Boolean).join(" ")
    : undefined;
  const quotaFull = hasNeuralwattSession ? buildQuotaText(Infinity) : undefined;

  // ─── Status bar ─────────────────────────────────────────────────────────
  const energyStatusbar = config.energy === "statusbar" && energyFull;
  const quotaStatusbar = config.quota === "statusbar" && quotaFull;
  const mcrStatusbar = config.mcr === "statusbar" && mcrFull;

  // Widget flags (also used by the standalone-region logic below).
  const showEnergyWidget = (config.energy === "widget" || config.mcr === "widget") && (energyFull || (config.mcr === "widget" && sessionMcrFp));
  const showQuotaWidget = config.quota === "widget" && quotaFull;

  // Region badge: rides the quota line when quota renders. When the quota line
  // is off / not rendering but carbon is on and we have a grid, render the badge
  // standalone so "where is the fleet" still shows. Placement then follows the
  // carbon mode (widget → below-editor widget; statusbar → quota status key).
  const hasGridForBadge = config.carbon !== "off" && hasNeuralwattSession && sessionGridId != null;
  const regionCarriedByQuota = showQuotaWidget || quotaStatusbar;
  const regionStandaloneText = hasGridForBadge && !regionCarriedByQuota ? buildRegionText(Infinity) : undefined;
  const regionStatusbar = config.carbon === "statusbar" && regionStandaloneText;

  if (energyStatusbar && quotaStatusbar) {
    const combined = ctx.ui.theme.fg("dim", energyFull! + " | " + quotaFull!);
    ctx.ui.setStatus(STATUS_KEY_ENERGY, combined);
    ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
  } else {
    if (energyStatusbar) {
      ctx.ui.setStatus(STATUS_KEY_ENERGY, ctx.ui.theme.fg("dim", energyFull!));
    } else {
      ctx.ui.setStatus(STATUS_KEY_ENERGY, undefined);
    }
    if (quotaStatusbar) {
      ctx.ui.setStatus(STATUS_KEY_QUOTA, ctx.ui.theme.fg("dim", quotaFull!));
    } else if (regionStatusbar) {
      ctx.ui.setStatus(STATUS_KEY_QUOTA, ctx.ui.theme.fg("dim", regionStandaloneText!));
    } else {
      ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
    }
  }
  if (mcrStatusbar) {
    ctx.ui.setStatus(STATUS_KEY_MCR, ctx.ui.theme.fg("dim", mcrFull!));
  } else {
    ctx.ui.setStatus(STATUS_KEY_MCR, undefined);
  }

  // ─── Widget assembly ─────────────────────────────────────────────────────
  // The widget stores raw (unthemed) text so it can re-compress the right
  // side at render time when the terminal is narrow. The right side is either
  // the quota line (buildQuotaText) or, when quota is off but carbon is on, the
  // standalone region badge (buildRegionText).
  // When config.mcr is "widget", MCR data is embedded in the energy text
  // (left side) via buildEnergyText; when "statusbar" or "off", it's excluded.
  if (showEnergyWidget || showQuotaWidget || (config.carbon === "widget" && regionStandaloneText)) {
    const leftRaw = energyFull ?? "";
    // Right side: quota line if it renders; else the standalone region when
    // there's a left (energy) side to pair it with.
    const rightRaw = showEnergyWidget && showQuotaWidget ? quotaFull!
      : showEnergyWidget && regionStandaloneText ? regionStandaloneText
      : undefined;
    const leftOnlyRaw = !showEnergyWidget && showQuotaWidget ? quotaFull!
      : !showEnergyWidget && regionStandaloneText ? regionStandaloneText
      : undefined;
    // Re-compress with buildRegionText when the right side is region-only.
    const rightIsRegionStandalone = !!rightRaw && rightRaw === regionStandaloneText;
    const compressRight = rightIsRegionStandalone ? buildRegionText : undefined;
    if (leftOnlyRaw) {
      ctx.ui.setWidget(
        "neuralwatt",
        (_ui: any, theme: any) => new StatusLineWidget(theme, leftOnlyRaw),
        { placement: "belowEditor" },
      );
    } else {
      ctx.ui.setWidget(
        "neuralwatt",
        (_ui: any, theme: any) => new StatusLineWidget(theme, leftRaw, rightRaw, compressRight),
        { placement: "belowEditor" },
      );
    }
  } else {
    ctx.ui.setWidget("neuralwatt", undefined);
  }
}

// ─── Energy Formatting ────────────────────────────────────────────────────────

function formatEnergy(joules: number): string {
  if (joules === 0) return "0 J";
  if (joules < 3.6) {
    return `${joules.toFixed(2)} J`;
  }
  const mwh = joules / 3600;
  if (mwh < 1000) {
    return `${mwh.toFixed(2)} mWh`;
  }
  const wh = mwh / 1000;
  if (wh < 1000) {
    return `${wh.toFixed(2)} Wh`;
  }
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)} kWh`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (usd < 1) return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

// ─── SSE Comment Reader ──────────────────────────────────────────────────────

export async function readEnergyFromTee(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.startsWith(": energy ")) {
      try {
        const energy = JSON.parse(trimmed.slice(9));
        pendingEnergyJoules += energy.energy_joules || 0;
        pendingEnergyRaw = energy;
      } catch {
        // Malformed energy comment, ignore
      }
    } else if (trimmed.startsWith(": mcr-session ")) {
      try {
        const mcr = JSON.parse(trimmed.slice(14));
        pendingMcrSessionRaw = mcr;
      } catch {
        // Malformed mcr-session comment, ignore
      }
    } else if (trimmed.startsWith(": cost ")) {
      try {
        const cost = JSON.parse(trimmed.slice(7));
        pendingCostUsd += cost.request_cost_usd || 0;
        pendingCostRaw = cost;
      } catch {
        // Malformed cost comment, ignore
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    }
  } catch {
    // Tee stream may error if the main stream is aborted — that's fine
  }

  // Flush any trailing bytes in the decoder and process the final line
  const final = decoder.decode(new Uint8Array(0), { stream: false });
  const remaining = (buffer + final).trim();
  if (remaining) {
    processLine(remaining);
  }

  try {
    reader.releaseLock();
  } catch {
    // Ignore
  }
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

export function streamNeuralwatt(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const apiKey = options?.apiKey || cachedApiKey || "";
  if (!apiKey) {
    throw new Error(
      `No API key for Neuralwatt. Add it to ~/.pi/agent/auth.json, ` +
      `set NEURALWATT_API_KEY env var, or use --api-key.`,
    );
  }

  const maxImages = model.vision?.maxImagesPerRequest as number | undefined;
  const transformedContext = transformContextForImageLimit(context, maxImages);

  const neuralwattModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || BASE_URL };

  // pi hands the user's thinking selection to streamSimple providers as
  // `options.reasoning` (a raw ThinkingLevel). The raw streamOpenAICompletions
  // only reads `options.reasoningEffort`, so we replicate the clamp+convert that
  // pi-ai's streamSimpleOpenAICompletions wrapper does — otherwise reasoning_effort
  // never reaches the request body and thinking levels silently do nothing
  // (off/high/xhigh all vanish from the payload for every Neuralwatt reasoning model).
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(neuralwattModel, options.reasoning) : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
  const { reasoning: _reasoning, ...streamOptions } = options ?? {};

  // Preserved thinking (full-history reasoning): when a model opts in via
  // `compat.chatTemplateKwargs`, inject those chat_template_kwargs into the
  // request body through pi-ai's onPayload hook. We do this here rather than
  // via thinkingFormat: "chat-template" because the chat-template branch is
  // mutually exclusive with the openai `reasoning_effort` path — using
  // onPayload keeps reasoning_effort (thinking-level control) AND adds the
  // preserve kwargs. Any caller-supplied onPayload is chained first so it can
  // inspect/replace the payload; our injection then merges into whatever
  // chat_template_kwargs the caller (or pi-ai) already set.
  const userOnPayload = streamOptions.onPayload;
  const extraKwargs = neuralwattModel.compat?.chatTemplateKwargs;
  const hasExtraKwargs =
    !!extraKwargs && typeof extraKwargs === "object" && Object.keys(extraKwargs).length > 0;
  const onPayload = hasExtraKwargs || userOnPayload
    ? async (params: any, mdl: any) => {
      let p = params;
      if (userOnPayload) {
        const next = await userOnPayload(p, mdl);
        if (next !== undefined) p = next;
      }
      if (hasExtraKwargs) {
        p = {
          ...p,
          chat_template_kwargs: {
            ...(p?.chat_template_kwargs ?? {}),
            ...extraKwargs,
          },
        };
      }
      return p;
    }
    : undefined;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (response.body && url.includes("/chat/completions")) {
      const [bodyForSdk, bodyForEnergy] = response.body.tee();
      teeReader = readEnergyFromTee(bodyForEnergy);
      return new Response(bodyForSdk, { headers: response.headers, status: response.status, statusText: response.statusText });
    }
    return response;
  };

  try {
    const stream = streamOpenAICompletions(neuralwattModel, transformedContext, {
      ...streamOptions,
      reasoningEffort,
      apiKey,
      ...(onPayload ? { onPayload } : {}),
    });

    const originalEnd = stream.end.bind(stream);
    stream.end = (result?: any) => {
      globalThis.fetch = originalFetch;
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

// Build the stale model list at module scope so neuralwatt-mcr.ts can import it
// for re-registration. This is idempotent — the same data index.ts uses.
let _staleModelsCache: NeuralwattModel[] | null = null;
export function getStaleModels(): NeuralwattModel[] {
  if (!_staleModelsCache) {
    const embedded = modelsData as NeuralwattModel[];
    const custom = customModelsData as NeuralwattModel[];
    const patches = patchesData as Record<string, any>;
    const staleBase = loadStaleModels(embedded);
    _staleModelsCache = buildModels(staleBase, custom, patches, config.modelOverrides);
  }
  return _staleModelsCache;
}

// Build the standard provider config object. Used by index.ts and neuralwatt-mcr.ts
// to ensure the same provider identity (api, streamSimple, headers) everywhere.
export function makeProviderConfig(models: NeuralwattModel[] = getStaleModels()) {
  return {
    baseUrl: BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "neuralwatt" as const,
    models,
    streamSimple: streamNeuralwatt,
    headers: {
      "X-NW-Conversation-ID": "$X_NW_CONVERSATION_ID",
      "X-NW-MCR-Ext-Version": "$X_NW_MCR_EXT_VERSION",
    },
  };
}

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as NeuralwattModel[];
  const customModels = customModelsData as NeuralwattModel[];
  const patches = patchesData as Record<string, any>;

  // Deferred model_select notify timer — see the model_select handler. Cleared on
  // rapid re-switch and on session_shutdown so only the latest switch notifies.
  let modelSelectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  const MODEL_SELECT_NOTIFY_DELAY_MS = 250;

  // Notify preserved-thinking state for a preserve-flag model. Computed from the
  // build pipeline (config as source of truth, not event.model.compat), deferred
  // so pi core's (and other extensions') notifications land first, and cancelled
  // on re-switch/shutdown so only the latest shows. Always level "info" (not a
  // warning) — the text conveys the coding/prose tradeoff.
  function notifyPreservedThinkingFor(model: any, ctx: any): void {
    if (!model || model.provider !== PROVIDER_ID) return;
    const entry = collectPreserveState().find((e: any) => e.id === model.id);
    if (!entry) return;
    const flagValue = entry.flag === "clear_thinking" ? !entry.preserved : entry.preserved;
    const msg = entry.preserved
      ? `Preserved thinking ON for ${entry.name} (${entry.flag}: ${flagValue}) — suited for coding, but not for prose. Open /neuralwatt-settings to change.`
      : `Preserved thinking OFF for ${entry.name} (${entry.flag}: ${flagValue}) — reasoning trimmed each turn (lighter; better for prose). Open /neuralwatt-settings to change.`;
    if (modelSelectNotifyTimer) clearTimeout(modelSelectNotifyTimer);
    modelSelectNotifyTimer = setTimeout(() => {
      modelSelectNotifyTimer = null;
      try { ctx.ui.notify(msg, "info"); } catch { /* notify is a no-op without a UI runner */ }
    }, MODEL_SELECT_NOTIFY_DELAY_MS);
  }

  pi.registerProvider("neuralwatt", makeProviderConfig());

  // Revalidate in background on session_start
  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    config = loadConfig();
    resetSessionState();
    cachedQuota = null;
    // Bust the stale-models cache so a user-edited neuralwatt.json (e.g. toggled
    // modelOverrides) takes effect this session instead of serving the
    // module-load snapshot until the background revalidate swaps it in.
    _staleModelsCache = null;
    replayEnergyEvents(ctx);
    // Re-register on session_start to guarantee our provider identity
    // (api, streamSimple, headers) wins over any load-time registration
    // from Chad's npm package (if installed alongside ours).
    // registerProvider replaces the entire entry, so this is idempotent.
    pi.registerProvider("neuralwatt", makeProviderConfig());
    updateEnergyStatus(ctx);
    // Show the preserved-thinking notification on first load / resume if the
    // active model carries a preserve flag (model_select may not fire on startup).
    notifyPreservedThinkingFor(ctx.model, ctx);
    resolveApiKey(ctx.modelRegistry).then(() => {
      // Pre-fetch quota eagerly so it's cached and ready to display as
      // soon as the first turn completes (updateEnergyStatus gates display
      // on hasNeuralwattSession, so nothing is shown before then).
      if (config.quota !== "off") {
        fetchQuota(cachedApiKey || "", signal).then((quota) => {
          if (quota && !signal.aborted) {
            cachedQuota = quota;
            updateEnergyStatus(ctx);
          }
        });
      }
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("neuralwatt", makeProviderConfig(buildModels(freshBase, customModels, patches, config.modelOverrides)));
        }
      });
    });
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Fetch quota once after the agent loop finishes to reflect updated balance
    if (config.quota !== "off" && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
      const quota = await fetchQuota(cachedApiKey || "");
      if (quota) {
        cachedQuota = quota;
        updateEnergyStatus(ctx);
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    revalidateAbort?.abort();
    if (modelSelectNotifyTimer) { clearTimeout(modelSelectNotifyTimer); modelSelectNotifyTimer = null; }
    cachedQuota = null;
    // Clear any status bar entries from energy/quota/MCR display modes.
    // (widget cleanup is handled by the extension runtime teardown)
    ctx.ui.setStatus(STATUS_KEY_ENERGY, undefined);
    ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
    ctx.ui.setStatus(STATUS_KEY_MCR, undefined);
  });

  pi.on("turn_end", async (event, ctx) => {
    // Ensure the energy tee reader has finished before committing.
    if (teeReader) {
      try {
        await teeReader;
      } catch {
        // Tee stream may error if the main stream was aborted
      }
      teeReader = undefined;
    }

    // Publish MCR data to the globalThis bridge so neuralwatt-mcr.ts can
    // read it regardless of ESM module instance identity.
    publishMCRRidge();

    // Extract MCR state from SSE payloads before clearing pending data
    if (pendingMcrSessionRaw && typeof pendingMcrSessionRaw.session_fp === "string") {
      sessionMcrFp = pendingMcrSessionRaw.session_fp as string;
      sessionSafeDropBefore =
        typeof pendingMcrSessionRaw.safe_drop_before === "number"
          ? (pendingMcrSessionRaw.safe_drop_before as number)
          : 0;
    }
    if (pendingEnergyRaw) {
      const mcr = pendingEnergyRaw.mcr as Record<string, unknown> | undefined;
      if (mcr && typeof mcr === "object") {
        if (typeof mcr.apc_hit_rate === "number") sessionApcHitRate = mcr.apc_hit_rate as number;
        if (typeof mcr.mcr_compacted_tokens === "number" && typeof mcr.mcr_original_tokens === "number") {
          sessionCompactRatio = (mcr.mcr_compacted_tokens as number) / (mcr.mcr_original_tokens as number);
        }
      }
      // Carbon (cumulative) + grid (latest-wins) from this turn's energy payload.
      const co2 = pendingEnergyRaw.carbon_g_co2eq;
      if (typeof co2 === "number") sessionCarbonGrams += co2;
      const gid = pendingEnergyRaw.grid_id;
      if (typeof gid === "string") sessionGridId = gid;
      const gi = pendingEnergyRaw.grid_carbon_intensity_gco2perkwhr;
      if (typeof gi === "number") sessionGridIntensity = gi;
      const csrc = pendingEnergyRaw.carbon_source;
      if (typeof csrc === "string") sessionGridCarbonSource = csrc;
    }

    if (pendingEnergyJoules > 0 || pendingCostUsd > 0 || pendingEnergyRaw || pendingMcrSessionRaw || pendingCostRaw) {
      const entry: EnergyEvent = {
        energy_joules: pendingEnergyJoules,
        cost_usd: pendingCostUsd,
      };
      if (pendingEnergyRaw) entry.sse_energy_raw = pendingEnergyRaw;
      if (pendingMcrSessionRaw) entry.sse_mcr_session_raw = pendingMcrSessionRaw;
      if (pendingCostRaw) entry.sse_cost_raw = pendingCostRaw;
      pi.appendEntry(ENERGY_ENTRY_TYPE, entry);
      sessionEnergyJoules += pendingEnergyJoules;
      sessionCostUsd += pendingCostUsd;

      // Emit per-turn energy data so other extensions (e.g. pi-tps) can display the
      // energy-billed cost as a $/M-tokens rate. pi dispatches turn_end handlers
      // sequentially (awaiting each in registration order), but extension load
      // order is not guaranteed — pi-tps subscribes to this event at load and
      // stashes costUsd keyed by turnIndex, so if it's registered after us it
      // captures this synchronously when its own turn_end runs; if before us,
      // it misses this one turn and falls back to the list-price rate. No emit
      // for turns without Neuralwatt activity (pending* is per-request), so
      // non-Neuralwatt turns never produce a spurious zero-cost signal.
      const turnIndex = typeof (event as any)?.turnIndex === "number" ? (event as any).turnIndex : null;
      pi.events?.emit("neuralwatt:turn-energy", {
        costUsd: pendingCostUsd,
        energyJoules: pendingEnergyJoules,
        turnIndex,
      });

      pendingEnergyJoules = 0;
      pendingCostUsd = 0;
      pendingEnergyRaw = null;
      pendingMcrSessionRaw = null;
      pendingCostRaw = null;
    }
    // If the session_start quota fetch hasn't landed yet (race), fetch now
    // so the very first turn always shows plan/allowance data.
    if (config.quota !== "off" && !cachedQuota && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
      const quota = await fetchQuota(cachedApiKey || "");
      if (quota) {
        cachedQuota = quota;
      }
    }
    updateEnergyStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);

    // Fetch quota if there was neuralwatt usage in the replayed tree
    if (config.quota !== "off" && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
      fetchQuota(cachedApiKey || "").then((quota) => {
        if (quota) {
          cachedQuota = quota;
          updateEnergyStatus(ctx);
        }
      });
    }
  });

  // ─── /neuralwatt-settings: settings UI (mirrors pi core /settings) ──────────
  // Opens a SettingsList (lazy-imported from pi-tui) via ctx.ui.custom(). Toggles
  // write to ~/.pi/agent/extensions/neuralwatt.json (raw read-modify-write so
  // unrelated fields survive), refresh the in-memory config, bust the stale-model
  // cache, and re-register the provider so the change takes effect immediately.
  function collectPreserveState(): Array<{ id: string; name: string; flag: "clear_thinking" | "preserve_thinking"; preserved: boolean }> {
    const resolved = buildModels(loadStaleModels(embeddedModels), customModels, patches, config.modelOverrides);
    const out: Array<{ id: string; name: string; flag: "clear_thinking" | "preserve_thinking"; preserved: boolean }> = [];
    for (const m of resolved) {
      const kwargs = (m as any).compat?.chatTemplateKwargs;
      if (!kwargs || typeof kwargs !== "object") continue;
      if (typeof kwargs.clear_thinking === "boolean") {
        out.push({ id: m.id, name: (m as any).name || m.id, flag: "clear_thinking", preserved: kwargs.clear_thinking === false });
      } else if (typeof kwargs.preserve_thinking === "boolean") {
        out.push({ id: m.id, name: (m as any).name || m.id, flag: "preserve_thinking", preserved: kwargs.preserve_thinking === true });
      }
    }
    return out;
  }

  pi.registerCommand("neuralwatt-settings", {
    description: "Configure Neuralwatt: preserved thinking per model + energy/quota/MCR/carbon display",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/neuralwatt-settings requires a UI (TUI or GUI).", "error");
          return;
        }
        const guiItems: any[] = [
          { id: "preserved-thinking", label: "Preserved thinking", current: "configure" },
          { id: "energy", label: "Energy display", current: config.energy, values: ["widget", "statusbar", "off"] },
          { id: "quota", label: "Quota display", current: config.quota, values: ["widget", "statusbar", "off"] },
          { id: "mcr", label: "MCR display", current: config.mcr, values: ["widget", "statusbar", "off"] },
          { id: "carbon", label: "Carbon display", current: config.carbon, values: ["widget", "statusbar", "off"] },
          { id: "hideOnOtherProvider", label: "Hide on other provider", current: config.hideOnOtherProvider ? "true" : "false", values: ["true", "false"] },
        ];
        const pick = await ctx.ui.select(
          "Neuralwatt settings \u2014 pick a setting",
          guiItems.map((i) => `${i.label}: ${i.current}`),
        );
        if (pick === undefined) return;
        const item = guiItems.find((i) => pick.startsWith(`${i.label}:`));
        if (!item) return;
        if (item.id === "preserved-thinking") {
          const fresh = collectPreserveState();
          if (fresh.length === 0) {
            ctx.ui.notify("No models support preserved thinking.", "info");
            return;
          }
          const modelPick = await ctx.ui.select(
            "Preserved thinking \u2014 pick a model",
            fresh.map((e) => `${e.name}: ${e.preserved ? "Preserve Thinking" : "Clear Thinking"}`),
          );
          if (modelPick === undefined) return;
          const entry = fresh.find((e) => modelPick.startsWith(`${e.name}:`));
          if (!entry) return;
          const v = await ctx.ui.select(entry.name, ["Preserve Thinking", "Clear Thinking"]);
          if (v === undefined) return;
          const preservedOn = v === "Preserve Thinking";
          const flagValue = entry.flag === "clear_thinking" ? !preservedOn : preservedOn;
          const raw = readRawNeuralwattConfig();
          const overrides = raw.modelOverrides ?? (raw.modelOverrides = {});
          const ov = overrides[entry.id] ?? (overrides[entry.id] = {});
          const compat = ov.compat ?? (ov.compat = {});
          const kwargs = compat.chatTemplateKwargs ?? (compat.chatTemplateKwargs = {});
          kwargs[entry.flag] = flagValue;
          writeRawNeuralwattConfig(raw);
          config = loadConfig();
          _staleModelsCache = null;
          pi.registerProvider("neuralwatt", makeProviderConfig(buildModels(loadStaleModels(embeddedModels), customModels, patches, config.modelOverrides)));
          ctx.ui.notify(`Preserved thinking ${preservedOn ? "on" : "off"} for ${entry.name} \u2014 takes effect now.`, "info");
        } else {
          const v = await ctx.ui.select(item.label, item.values);
          if (v === undefined) return;
          const raw = readRawNeuralwattConfig();
          if (item.id === "hideOnOtherProvider") {
            raw.hideOnOtherProvider = v === "true";
          } else {
            raw[item.id] = v;
          }
          writeRawNeuralwattConfig(raw);
          config = loadConfig();
          updateEnergyStatus(ctx);
          ctx.ui.notify(`${item.label} set to ${v}.`, "info");
        }
        ctx.ui.notify("Run /neuralwatt-settings again for more.", "info");
        return;
      }
      const { SettingsList, Container } = await import("@earendil-works/pi-tui");
      const { getSettingsListTheme, DynamicBorder } = await import("@earendil-works/pi-coding-agent");

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
        // SettingsList left-aligns the value column after the widest label (capped
        // at 30 cols). A label wider than 30 shifts that row's value out of
        // alignment, so cap model-name labels.
        const truncateLabel = (s: string) => (s.length > 30 ? s.slice(0, 27) + "..." : s);

        const items: any[] = [
          {
            id: "preserved-thinking",
            label: "Preserved thinking ›",
            description: "Per-model Preserve Thinking / Clear Thinking (full-history reasoning). Preserve Thinking keeps all turns' reasoning; Clear Thinking lets the template drop older reasoning (saves tokens, can hurt multi-turn recall / cause overthinking).",
            currentValue: "configure",
            submenu: (_currentValue: string, subDone: (v?: string) => void) => {
              // Re-read state on each open so toggles from a previous visit (which
              // wrote neuralwatt.json + refreshed config) are reflected — a snapshot
              // captured at panel-open time would show stale values after a toggle.
              const fresh = collectPreserveState();
              const subItems = fresh.map((e) => ({
                id: `preserve:${e.id}`,
                label: truncateLabel(e.name),
                description: `${e.id} — Preserve Thinking keeps full reasoning history across turns; Clear Thinking lets the template drop older reasoning (saves tokens, can hurt multi-turn recall / cause overthinking).`,
                currentValue: e.preserved ? "Preserve Thinking" : "Clear Thinking",
                values: ["Preserve Thinking", "Clear Thinking"],
              }));
              const subList = new SettingsList(
                subItems,
                Math.min(subItems.length + 2, 15),
                getSettingsListTheme(),
                (id: string, newValue: string) => {
                  const modelId = id.slice("preserve:".length);
                  const entry = fresh.find((p) => p.id === modelId);
                  if (!entry) return;
                  const preservedOn = newValue === "Preserve Thinking";
                  const flagValue = entry.flag === "clear_thinking" ? !preservedOn : preservedOn;
                  const raw = readRawNeuralwattConfig();
                  const overrides = raw.modelOverrides ?? (raw.modelOverrides = {});
                  const ov = overrides[modelId] ?? (overrides[modelId] = {});
                  const compat = ov.compat ?? (ov.compat = {});
                  const kwargs = compat.chatTemplateKwargs ?? (compat.chatTemplateKwargs = {});
                  kwargs[entry.flag] = flagValue;
                  writeRawNeuralwattConfig(raw);
                  config = loadConfig();
                  _staleModelsCache = null;
                  pi.registerProvider("neuralwatt", makeProviderConfig(buildModels(loadStaleModels(embeddedModels), customModels, patches, config.modelOverrides)));
                  ctx.ui.notify(`Preserved thinking ${preservedOn ? "on" : "off"} for ${entry.name} — takes effect now.`, "info");
                },
                () => subDone(),
                { enableSearch: true },
              );
              // The outer container's borders already frame the panel; return the
              // list directly so we don't render a second border pair.
              return subList;
            },
          },
          {
            id: "energy",
            label: "Energy display",
            description: "Where energy/cost is shown: dedicated below-editor line, status bar, or hidden",
            currentValue: config.energy,
            values: ["widget", "statusbar", "off"],
          },
          {
            id: "quota",
            label: "Quota display",
            description: "Where plan/quota is shown. 'off' also skips the /v1/quota fetch",
            currentValue: config.quota,
            values: ["widget", "statusbar", "off"],
          },
          {
            id: "mcr",
            label: "MCR display",
            description: "Where MCR (context-reuse) info is shown",
            currentValue: config.mcr,
            values: ["widget", "statusbar", "off"],
          },
          {
            id: "carbon",
            label: "Carbon display",
            description: "Where session CO₂ emissions (energy line) and the fleet grid/region badge (quota line) are shown",
            currentValue: config.carbon,
            values: ["widget", "statusbar", "off"],
          },
          {
            id: "hideOnOtherProvider",
            label: "Hide on other provider",
            description: "Hide all Neuralwatt display when a non-Neuralwatt model is active",
            currentValue: config.hideOnOtherProvider ? "true" : "false",
            values: ["true", "false"],
          },
        ];

        const container = new Container();
        container.addChild(border());

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            if (id === "energy" || id === "quota" || id === "mcr" || id === "carbon") {
              const raw = readRawNeuralwattConfig();
              raw[id] = newValue;
              writeRawNeuralwattConfig(raw);
              config = loadConfig();
              updateEnergyStatus(ctx);
            } else if (id === "hideOnOtherProvider") {
              const raw = readRawNeuralwattConfig();
              raw.hideOnOtherProvider = newValue === "true";
              writeRawNeuralwattConfig(raw);
              config = loadConfig();
              updateEnergyStatus(ctx);
            }
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        container.addChild(border());

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
          },
        };
      });
    },
  });

  // Re-evaluate display when the active model changes (for hideOnOtherProvider),
  // and notify preserved-thinking state for models carrying a preserve flag
  // (e.g. GLM-5.2 family, Kimi K2.6/K2.7).
  pi.on("model_select", async (event, ctx) => {
    updateEnergyStatus(ctx);
    notifyPreservedThinkingFor(event.model ?? ctx.model, ctx);
  });
}
