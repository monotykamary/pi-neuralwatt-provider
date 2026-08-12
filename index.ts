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
 *   3. Grace-period models from deprecated-models.json seeded into the base list
 *      (served until update-models.js evicts them, 14 days after delisting)
 *   4. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded|deprecated-graveyard] → apply patch.json → merge custom-models.json → transform
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
 *     "hideOnOtherProvider": false,  // hide display when a non-Neuralwatt model is active
 *     "baseUrl": "https://api.neuralwatt.com/v1"  // optional: route all API traffic through a proxy
 *   }
 *
 *   - "widget" (default): rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (for quota, also skips the API fetch)
 *   - hideOnOtherProvider: when true, auto-hide all Neuralwatt display if the
 *     active model's provider is not "neuralwatt". The display returns when you
 *     switch back to a Neuralwatt model. Default: false.
 *   - baseUrl: override the provider API URL. Every request (chat completions,
 *     /models sync, /quota) goes to this URL instead of the default. Useful
 *     with a proxy such as Headroom. Default: https://api.neuralwatt.com/v1
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
 *   - Flex tier: effective discount % + queue wait derived per request from
 *     SSE data chunks (the API bills flex at a reduced rate but exposes no
 *     explicit discount field — see docs/sse-payloads.md)
 *
 * @see https://neuralwatt.com
 */

import type { SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchesData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
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
  // Override for the provider API URL. Every request (chat completions,
  // /models sync, /quota) goes here instead of api.neuralwatt.com. Use with
  // a proxy such as Headroom. Default: BASE_URL.
  baseUrl?: string;
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

// Accept only absolute http(s) URLs; strip trailing slashes so "/quota" style
// joins never produce double slashes. Anything else falls back to BASE_URL.
function parseBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/.+/.test(url) ? url : undefined;
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
      baseUrl: parseBaseUrl(raw.baseUrl),
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
        if (v === null || typeof v === "string") m[k] = typeof v === "string" ? v : null;
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
    off?: string | null;
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

/** Full pipeline: base(+graveyard) → patch → custom → user modelOverrides → result */
export function buildModels(
  base: NeuralwattModel[],
  custom: NeuralwattModel[],
  patchList: Record<string, any>,
  overrides: Record<string, ModelOverride> = {},
  deprecated: DeprecatedModelMap = embeddedDeprecated,
): NeuralwattModel[] {
  const modelMap = new Map<string, NeuralwattModel>();

  // Seed with the base list plus grace-period deprecated models so patch.json
  // entries and user modelOverrides reach deprecated models exactly as they
  // did while the model was live (withDeprecated keeps live data on conflicts).
  for (const model of withDeprecated(base, deprecated)) {
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

// The API root for every outbound request. Defaults to api.neuralwatt.com;
// a baseUrl in ~/.pi/agent/extensions/neuralwatt.json wins (proxy setups).
function resolveBaseUrl(): string {
  return config.baseUrl ?? BASE_URL;
}
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// pi thinking levels, ordered low→high. "off" is handled separately (it maps
// onto a native "none" effort / omitted effort / hidden, never a named level).
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Derive pi's thinkingLevelMap from the API's metadata.reasoning block:
 *   { mandatory, default_enabled, supported_efforts, default_effort,
 *     accepted_efforts, effort_aliases }
 *
 * Only canonical supported_efforts become visible levels. Alias-only levels
 * (effort_aliases keys absent from supported_efforts) stay hidden (null):
 * pi's clampThinkingLevel up-clamps a hidden selection to the next visible
 * level, which is exactly the native level the alias would have resolved to.
 *
 * The "off" entry resolves to:
 *   - null   when reasoning is mandatory ("off" hidden — nothing to disable to)
 *   - "none" when the API accepts a native "none" effort (explicit disable)
 *   - absent when thinking is disabled by default (omitting the effort = off)
 *   - null   otherwise (enabled by default and no way to turn it off)
 *
 * Returns undefined when the block is missing or exposes no canonical pi
 * levels (boolean-only thinking) — the catalog entry then stays as before
 * (pi default 5 levels), and patch.json remains the override layer.
 */
export function deriveThinkingLevelMap(reasoning: any): NeuralwattModel["thinkingLevelMap"] {
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return undefined;

  const supported: string[] = Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : [];
  const accepted: string[] = Array.isArray(reasoning.accepted_efforts) ? reasoning.accepted_efforts : supported;
  const canonical = new Set(supported.filter((e) => (PI_THINKING_LEVELS as readonly string[]).includes(e)));
  if (canonical.size === 0) return undefined;

  const map: NonNullable<NeuralwattModel["thinkingLevelMap"]> = {};
  if (reasoning.mandatory === true) {
    map.off = null;
  } else if (accepted.includes("none")) {
    map.off = "none";
  } else if (reasoning.default_enabled !== false) {
    map.off = null;
  }
  for (const level of PI_THINKING_LEVELS) {
    map[level] = canonical.has(level) ? level : null;
  }
  return map;
}

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

  // Same derivation as scripts/update-models.js (the two transformModel
  // implementations mirror each other): metadata.reasoning → thinkingLevelMap.
  // patch.json maps still win by replacement in buildModels; this fills the gap
  // for models whose palette was never curated by hand.
  if (hasReasoning) {
    const thinkingLevelMap = deriveThinkingLevelMap(meta.reasoning);
    if (thinkingLevelMap) {
      model.thinkingLevelMap = thinkingLevelMap;
    }
  }

  return model;
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<NeuralwattModel[] | null> {
  try {
    const response = await fetch(`${resolveBaseUrl()}/models`, {
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

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
// patch.json entries follow the same lifetime: the sync script only cleans a
// patch entry once the model is evicted from this graveyard, and buildModels
// applies patch entries + user modelOverrides to grace-period models exactly
// as it does to live ones.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type DeprecatedModelMap = Record<string, NeuralwattModel & { deprecatedAt?: string }>;
const embeddedDeprecated = deprecatedData as DeprecatedModelMap;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(deprecated: DeprecatedModelMap = embeddedDeprecated): NeuralwattModel[] {
  const now = Date.now();
  const result: NeuralwattModel[] = [];
  for (const entry of Object.values(deprecated)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as NeuralwattModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have
// (live data wins). buildModels calls this when SEEDING the model map — before
// the patch/custom/override stages — so deprecated models receive patch.json
// entries and user modelOverrides just like live models do.
function withDeprecated(models: NeuralwattModel[], deprecated: DeprecatedModelMap = embeddedDeprecated): NeuralwattModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels(deprecated).filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
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
  // Derived per-request telemetry captured from SSE data chunks by the tee
  // reader (the _est fields are computed client-side, not upstream-verbatim).
  service_tier?: string;
  usage_tokens?: { prompt: number; completion: number; cached_input: number };
  queue_seconds?: number;
  flex_discount_pct_est?: number;
  // Estimated consumed (standard-price) cost: charged / 0.65 per the flex
  // pricing multiplier. Replaces the old token list-price estimate (charged
  // cost is energy-derived, not token-derived, so token list math was
  // meaningless).
  consumed_cost_usd_est?: number;
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
let pendingServiceTier: string | null = null;
let pendingUsage: TeeUsageTokens | null = null;
// Flex queue wait estimate derived from server-side chunk `created`
// timestamps (first content-bearing chunk − first heartbeat chunk), seconds.
let pendingQueueSeconds: number | undefined;
// Latest-turn flex telemetry for the footer badge (sticky, latest-wins like
// MCR fp / grid id).
let sessionFlexDiscountPct: number | undefined;
let sessionFlexQueueSeconds: number | undefined;
let teeReader: Promise<void> | undefined;
// Live in-flight flex queue indicator (left side of the energy widget): set
// when a -flex model's stream starts, cleared when it settles. Reference-
// counted because concurrent streams are possible; the sticky latest-turn
// badge state above is untouched by this.
let liveFlexStreams = 0;
let liveFlexStartedAt: number | null = null;
let liveFlexTicker: ReturnType<typeof setInterval> | undefined;
let lastFooterCtx: { ui: any } | null = null;

function trackTeeReader(reader: Promise<void>): void {
  const settled = reader.catch(() => {});
  teeReader = teeReader
    ? Promise.all([teeReader, settled]).then(() => undefined)
    : settled;
}

async function settleTeeReaders(): Promise<void> {
  while (teeReader) {
    const current = teeReader;
    await current;
    if (teeReader === current) teeReader = undefined;
  }
}

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
  return { pendingEnergyJoules, pendingCostUsd, teeReader, pendingEnergyRaw, pendingMcrSessionRaw, pendingCostRaw, pendingServiceTier, pendingUsage, pendingQueueSeconds };
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
  sessionFlexDiscountPct = undefined;
  sessionFlexQueueSeconds = undefined;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
  pendingEnergyRaw = null;
  pendingMcrSessionRaw = null;
  pendingCostRaw = null;
  pendingServiceTier = null;
  pendingUsage = null;
  pendingQueueSeconds = undefined;
  teeReader = undefined;
  // Also clear the bridge so stale data doesn't leak across tests
  const bridge = (globalThis as any)[NW_MCR_BRIDGE];
  if (bridge) {
    bridge.energyRaw = null;
    bridge.mcrSessionRaw = null;
    bridge.costRaw = null;
  }
}

function replayEnergyEvents(ctx: any): void {
  sessionFlexDiscountPct = undefined;
  sessionFlexQueueSeconds = undefined;
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
      // Flex badge is latest-wins: restore from the most recent entry that
      // recorded a service tier; a standard-tier turn clears it.
      if (entry.data.service_tier === "flex") {
        // Effective (measured-or-documented) flex discount; legacy entries
        // may carry a derived estimate from the era when it was (incorrectly)
        // computed from token list prices — never restore those.
        sessionFlexDiscountPct = effectiveFlexDiscountPct();
        sessionFlexQueueSeconds =
          typeof entry.data.queue_seconds === "number" ? entry.data.queue_seconds : undefined;
      } else if (typeof entry.data.service_tier === "string") {
        sessionFlexDiscountPct = undefined;
        sessionFlexQueueSeconds = undefined;
      }
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
//   ⚡5.68 mWh $0.003829   full: value (spaced unit) + cost
//   ⚡5.68mWh $0.003829    compressed: value (merged unit) + cost
//   ⚡5.68mWh              compressed value only (cost dropped)
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
//   ⚡5.68 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5 APC 85% compact 45%
//   ⚡5.68 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5 APC 85%
//   ⚡5.68 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0 drop<5
//   ⚡5.68 mWh $0.003829 🌱1.24 g CO₂  MCR 3bb342a0
//   ⚡5.68 mWh $0.003829 🌱1.24 g CO₂
//   ⚡5.68 mWh $0.003829 🌱1.24 g                          drop "CO₂" suffix
//   ⚡5.68 mWh $0.003829 🌱1.24g                          compact carbon
//   ⚡5.68 mWh $0.003829                                 drop carbon
//   ⚡5.68mWh $0.003829                                 compressed + cost
//   ⚡5.68mWh                                            compressed only
function buildEnergyText(maxCols: number): string | undefined {
  const hasEnergy = sessionEnergyJoules > 0 || sessionCostUsd > 0;
  const hasMCR = config.mcr !== "off" && sessionMcrFp !== null;
  const hasCarbon = config.carbon !== "off" && sessionCarbonGrams > 0;

  if (!hasEnergy && !hasMCR) {
    // Nothing recorded yet — but a flex request may be waiting in the queue:
    // show the live ticker even before the session's first completed turn.
    if (liveFlexStartedAt === null) return undefined;
    const elapsed = liveFlexElapsedSeconds(liveFlexStartedAt, Date.now());
    return elapsed === undefined
      ? undefined
      : flexLiveTiers(elapsed, sessionFlexDiscountPct !== undefined ? effectiveFlexDiscountPct() : undefined)[0];
  }

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

  // Flex badge tiers. While a flex stream is in flight this switches to a
  // live wait ticker (full tier keeps the previous turn's discount). At rest:
  // effective discount + queue wait of the latest flex request
  // ("flex −82% · queued ~6m05s" → "flex −82%" → dropped). Most auxiliary
  // segment — dropped after MCR but before carbon.
  const flexTiers: string[] = [];
  const liveWait = liveFlexStartedAt !== null
    ? liveFlexElapsedSeconds(liveFlexStartedAt, Date.now())
    : undefined;
  if (liveWait !== undefined) {
    flexTiers.push(...flexLiveTiers(liveWait, sessionFlexDiscountPct !== undefined ? effectiveFlexDiscountPct() : undefined));
  } else if (sessionFlexDiscountPct !== undefined) {
    const pctTag = `flex −${effectiveFlexDiscountPct()}%`;
    const q = sessionFlexQueueSeconds && sessionFlexQueueSeconds > 0
      ? ` · queued ${formatQueueWait(sessionFlexQueueSeconds)}`
      : "";
    flexTiers.push(`${pctTag}${q}`, pctTag, "");
  } else {
    flexTiers.push("");
  }
  const flexFull = flexTiers[0];

  // left = energy core + (carbon segment if any) + (flex badge if any).
  // Single spaces: carbon and flex are part of the energy core, not separate
  // panels like MCR (which uses two spaces).
  const leftWith = (carbonText: string, flexText = "") =>
    coreFull + (carbonText ? ` ${carbonText}` : "") + (flexText ? ` ${flexText}` : "");

  const candidates: string[] = [];
  const carbonFull = carbonTiers[0];

  if (hasEnergy) {
    // Phase 1: drop MCR parts (carbon and flex full, core full).
    for (const mcrText of mcrTiers) {
      const left = leftWith(carbonFull, flexFull);
      const c = mcrText ? `${left}  ${mcrText}` : left;
      if (c !== candidates[candidates.length - 1]) candidates.push(c);
    }
    // Phase 2: MCR dropped — drop flex badge tiers (carbon full, core full).
    for (const flexText of flexTiers.slice(1)) {
      const c = leftWith(carbonFull, flexText);
      if (c !== candidates[candidates.length - 1]) candidates.push(c);
    }
    // Phase 3: flex badge dropped — drop carbon tiers (core full).
    for (const carbonText of carbonTiers.slice(1)) {
      const c = leftWith(carbonText);
      if (c !== candidates[candidates.length - 1]) candidates.push(c);
    }
    // Phase 4: compress energy core (carbon, flex & MCR dropped).
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

// Compact energy format: merges value and unit with no space ("5.68mWh" vs "5.68 mWh").
function formatEnergyCompact(joules: number): string {
  if (joules === 0) return "0J";
  if (joules < 3.6) {
    return `${joules.toFixed(2)}J`;
  }
  const mwh = joules / 3.6;
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
let measuredFlexMultiplier: number | undefined;

async function fetchQuota(apiKey: string, signal?: AbortSignal): Promise<QuotaResponse | null> {
  try {
    const response = await fetch(`${resolveBaseUrl()}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as QuotaResponse;
  } catch {
    return null;
  }
}

// Refresh the measured flex multiplier in the background (fire-and-forget;
// never blocks the turn flow). Call sites mirror the quota refresh points.
function refreshFlexPricingMeasurement(apiKey: string, signal?: AbortSignal): void {
  void fetchFlexPricingMultiplier(apiKey, signal)
    .then((m) => {
      if (m !== undefined) {
        measuredFlexMultiplier = m;
        refreshLiveFlexBadge(); // badge may now show the measured discount
      }
    })
    .catch(() => { /* best-effort */ });
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


function refreshLiveFlexBadge(): void {
  if (!lastFooterCtx) return;
  try {
    updateEnergyStatus(lastFooterCtx);
  } catch {
    // Stale ctx after TUI teardown — ignore
  }
}

function markLiveFlexStream(): void {
  if (liveFlexStreams++ > 0) return; // concurrent flex streams: keep the first start
  liveFlexStartedAt = Date.now();
  liveFlexTicker = setInterval(refreshLiveFlexBadge, 1000);
  (liveFlexTicker as unknown as { unref?: () => void }).unref?.();
  refreshLiveFlexBadge();
}

function stopLiveFlexStream(): void {
  if (liveFlexStreams > 0) liveFlexStreams--;
  if (liveFlexStreams > 0) return;
  liveFlexStartedAt = null;
  if (liveFlexTicker !== undefined) {
    clearInterval(liveFlexTicker);
    liveFlexTicker = undefined;
  }
  refreshLiveFlexBadge();
}

function updateEnergyStatus(ctx: any): void {
  // Stash for the live flex ticker's ~1s re-renders.
  lastFooterCtx = ctx;
  // Show the status line only after neuralwatt activity is recorded in this
  // session. This avoids showing quota/energy data in sessions that use a
  // different provider, and prevents the quota from appearing before any
  // turn has completed (quota is pre-fetched eagerly so it's ready to display
  // as soon as the first turn ends, alongside the energy data).
  const hasNeuralwattSession = sessionEnergyJoules > 0 || sessionCostUsd > 0 || sessionMcrFp !== null || sessionCarbonGrams > 0 || sessionGridId !== null || liveFlexStartedAt !== null;

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
      // Quota/region only (no energy left side yet): render the text on the
      // right side of the widget, not left — otherwise it visually "collapses"
      // to the left before the first flex/energy turn of a session.
      const onlyRegion = !showQuotaWidget && !!regionStandaloneText;
      ctx.ui.setWidget(
        "neuralwatt",
        (_ui: any, theme: any) => new StatusLineWidget(theme, "", leftOnlyRaw, onlyRegion ? buildRegionText : undefined),
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
  const mwh = joules / 3.6;
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

export interface TeeUsageTokens {
  prompt?: number;
  completion?: number;
  cachedInput?: number;
}

// Flex pricing per the official flex-tier docs
// (https://portal.neuralwatt.com/docs/guides/flex-tier): charged = consumed ×
// pricing multiplier; today flex is a fixed 35% off standard (0.65). Charged
// cost is ENERGY-derived, not token-derived, so it cannot be derived from —
// or compared against — token list prices (a previous revision did exactly
// that and surfaced meaningless 2–98% numbers). Wait-time buckets with
// different discounts are on the provider's roadmap; when that ships the
// measured derivation below starts reporting the real mix automatically while
// this constant remains the no/low-data fallback.
export const FLEX_PRICING_MULTIPLIER = 0.65;
export const FLEX_DISCOUNT_PCT = Math.round((1 - FLEX_PRICING_MULTIPLIER) * 100);

// Estimated consumed (standard-price equivalent) cost of a flex request.
// Uses the measured multiplier when account usage provides enough flex kWh
// to derive it, else the documented constant.
export function flexConsumedCostUsdEst(chargedUsd: number): number | undefined {
  return chargedUsd > 0 ? chargedUsd / effectiveFlexMultiplier() : undefined;
}

function effectiveFlexMultiplier(): number {
  return measuredFlexMultiplier ?? FLEX_PRICING_MULTIPLIER;
}

// Discount badge: measured account multiplier when available, else documented.
export function effectiveFlexDiscountPct(): number {
  const m = effectiveFlexMultiplier();
  return Math.max(0, Math.min(99, Math.round((1 - m) * 100)));
}

// Minimum aggregate flex consumption (kWh) before trusting the derived
// multiplier — below this, millikWh truncation and measurement noise swamp
// the ratio.
const FLEX_MEASURE_MIN_KWH = 0.02;
const USAGE_WINDOW_DAYS = 7;

interface UsageSummaryResponse {
  accounting_method?: string;
  totals?: { energy_kwh_consumed?: number; energy_kwh_charged?: number };
}
interface UsageByModelResponse {
  products?: Array<{ requested_model?: string; energy_kwh?: number }>;
  models?: Array<{ model?: string; energy_kwh?: number }>;
}

// Derive the account's effective flex pricing multiplier from the usage API:
//   charged_kwh = std_consumed + M × flex_consumed   ⇒   M = 1 − Δ / flexKwh
// where Δ = consumed − charged and flexKwh is the sum of products[] kWh for
// requested *-flex models over the window (some requests made under flex
// names can appear under served-model rows before the 2026-07-24 requested-
// name cutover — recent windows only). Gated on energy accounting, enough
// flex volume, and a sane result; otherwise undefined (→ documented constant).
export function deriveFlexMultiplier(
  summary: UsageSummaryResponse,
  byModel: UsageByModelResponse,
): number | undefined {
  if (summary.accounting_method && summary.accounting_method !== "energy") return undefined;
  const consumed = summary.totals?.energy_kwh_consumed;
  const charged = summary.totals?.energy_kwh_charged;
  if (typeof consumed !== "number" || typeof charged !== "number") return undefined;
  if (!(consumed > 0) || !(charged > 0)) return undefined;
  let flexKwh = 0;
  const rows = (byModel.products ?? byModel.models ?? []) as Array<{ requested_model?: string; model?: string; energy_kwh?: number }>;
  for (const row of rows) {
    const name = row.requested_model ?? row.model ?? "";
    if (name.endsWith("-flex") && typeof row.energy_kwh === "number") flexKwh += row.energy_kwh;
  }
  if (flexKwh < FLEX_MEASURE_MIN_KWH) return undefined;
  if (flexKwh >= consumed) return undefined; // flex can't exceed total consumption
  const m = (charged - (consumed - flexKwh)) / flexKwh;
  // Sanity: a real flex tier lives between "free" and "standard price".
  if (!(m > 0.05 && m <= 1.0)) return undefined;
  return m;
}

export async function fetchFlexPricingMultiplier(apiKey: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - USAGE_WINDOW_DAYS * 86400_000);
    const qs = `start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;
    const mk = () => (signal
      ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal])
      : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS));
    const headers = { Authorization: `Bearer ${apiKey}` };
    const [summaryRes, byModelRes] = await Promise.all([
      fetch(`${resolveBaseUrl()}/usage/summary?${qs}`, { headers, signal: mk() }),
      fetch(`${resolveBaseUrl()}/usage/by-model?${qs}`, { headers, signal: mk() }),
    ]);
    if (!summaryRes.ok || !byModelRes.ok) return undefined;
    return deriveFlexMultiplier(
      (await summaryRes.json()) as UsageSummaryResponse,
      (await byModelRes.json()) as UsageByModelResponse,
    );
  } catch {
    return undefined;
  }
}

function formatQueueWait(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `~${s}s`;
  return `~${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const LIVE_FLEX_MIN_SECONDS = 2;

// Whole seconds elapsed since a flex stream started, or undefined inside the
// grace window (requests that start generating within 2s never show a ticker).
export function liveFlexElapsedSeconds(startedAt: number, now: number): number | undefined {
  const s = Math.floor((now - startedAt) / 1000);
  return s >= LIVE_FLEX_MIN_SECONDS ? s : undefined;
}

// Fixed-width m:ss clock for the live flex ticker. Constant width matters:
// the ticker re-renders the footer every second, and a growing wait string
// would push the right side of the widget against its compression budget,
// making it visibly reflow on every digit rollover.
export function formatLiveWait(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  if (m > 99) return "99:59+";
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Progressive-disclosure tiers for the live (in-flight) flex badge.
export function flexLiveTiers(elapsedSeconds: number, previousDiscountPct?: number): string[] {
  const wait = formatLiveWait(elapsedSeconds);
  const waitTag = `flex queued ${wait}`;
  const full = previousDiscountPct !== undefined
    ? `flex −${previousDiscountPct}% · queued ${wait}`
    : waitTag;
  return full === waitTag ? [waitTag, ""] : [full, waitTag, ""];
}

// Debug/test accessor: live flex queue indicator state.
export function liveFlexQueueState(): { streams: number; startedAt: number | null } {
  return { streams: liveFlexStreams, startedAt: liveFlexStartedAt };
}

// ─── SSE Comment Reader ──────────────────────────────────────────────────────

export async function readEnergyFromTee(
  body: ReadableStream<Uint8Array>,
  onCost?: (costUsd: number | undefined) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Billed cost for THIS stream. The flex/SSE data chunk's cost_usd is exact
  // per-request; the `: cost` comment sum is the fallback (same number the
  // turn_end energy entry reads via pendingCostUsd, which is a global
  // accumulator — the local copy is what the stream-cost wrapper needs to
  // isolate concurrent requests from each other).
  let dataCostUsd: number | undefined;
  let commentCostUsd = 0;

  // Per-stream flex telemetry, captured from SSE data chunks (not comments).
  // Flex requests held in the server-side queue emit heartbeat chunks —
  // data frames with an empty delta and no service_tier — roughly every 10s
  // until generation starts. We never JSON.parse content chunks (the SDK
  // already does that on the other tee branch); only cheap regexes run here,
  // plus one parse for the final usage frame.
  let firstHeartbeatCreated: number | undefined;
  let sawContentChunk = false;

  function captureDataChunk(trimmed: string): void {
    if (!pendingServiceTier) {
      const tier = /"service_tier"\s*:\s*"([^"]+)"/.exec(trimmed);
      if (tier) pendingServiceTier = tier[1];
    }
    if (!sawContentChunk) {
      const created = /"created"\s*:\s*(\d+)/.exec(trimmed);
      if (/"delta"\s*:\s*\{\s*\}/.test(trimmed)) {
        // Queue heartbeat: empty delta while the request is held server-side.
        if (firstHeartbeatCreated === undefined && created) firstHeartbeatCreated = Number(created[1]);
      } else if (/"delta"\s*:\s*\{[^}]/.test(trimmed)) {
        // First chunk whose delta carries something: the queue is over.
        sawContentChunk = true;
        if (firstHeartbeatCreated !== undefined && created) {
          pendingQueueSeconds = Math.max(0, Number(created[1]) - firstHeartbeatCreated);
        }
      }
    }
    if (trimmed.includes('"cost_usd"')) {
      try {
        const chunk = JSON.parse(trimmed.slice(5));
        const c = chunk?.cost_usd;
        if (typeof c === "number" && Number.isFinite(c) && c >= 0) dataCostUsd = c;
      } catch {
        // Malformed cost data frame, ignore
      }
    }
    if (/"usage"\s*:\s*\{/.test(trimmed)) {
      try {
        const chunk = JSON.parse(trimmed.slice(5));
        const u = chunk?.usage;
        if (u && typeof u === "object") {
          pendingUsage = {
            prompt: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
            completion: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
            cachedInput:
              typeof u.prompt_tokens_details?.cached_tokens === "number"
                ? u.prompt_tokens_details.cached_tokens
                : 0,
          };
        }
      } catch {
        // Malformed usage chunk, ignore
      }
    }
  }

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
        commentCostUsd += cost.request_cost_usd || 0;
        pendingCostRaw = cost;
      } catch {
        // Malformed cost comment, ignore
      }
    } else if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
      captureDataChunk(trimmed);
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
    onCost?.(dataCostUsd ?? (commentCostUsd > 0 ? commentCostUsd : undefined));
  } catch {
    // Non-fatal: cost observer is best-effort
  }

  try {
    reader.releaseLock();
  } catch {
    // Ignore
  }
}

/**
 * Overwrite an assistant message's usage.cost with NeuralWatt's metered billed
 * cost, scaling the component costs proportionally so they still sum to total.
 * pi's footer and session totals scan usage.cost on committed entries
 * (usage-totals), so fixing the message in-stream (before pi commits it) makes
 * every cost surface exact for the current turn — flex discounts included.
 */
export function applyBilledCostToUsage(usage: any, billedUsd: number): void {
  const c = usage?.cost;
  if (!c) return;
  const listTotal = typeof c.total === "number" && c.total > 0 ? c.total : 0;
  if (listTotal > 0) {
    const factor = billedUsd / listTotal;
    c.input = (c.input || 0) * factor;
    c.output = (c.output || 0) * factor;
    c.cacheRead = (c.cacheRead || 0) * factor;
    c.cacheWrite = (c.cacheWrite || 0) * factor;
  } else {
    c.input = 0;
    c.output = 0;
    c.cacheRead = 0;
    c.cacheWrite = 0;
  }
  c.total = billedUsd;
}

/**
 * Wrap an assistant-message event stream so that the final `done` message's
 * usage.cost carries the metered billed cost (revealed by SSE cost/data
 * frames) instead of the list-priced token cost pi-ai computed when parsing
 * the usage chunk. getBilledUsd is awaited at `done`, before the event is
 * pushed downstream — the caller resolves it after the request's tee reader
 * has settled so the billed number is guaranteed parsed.
 */
export function wrapStreamWithBilledCost(
  inner: AssistantMessageEventStream,
  getBilledUsd: () => Promise<number | undefined>,
  onSettled?: () => void,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  (async () => {
    try {
      for await (const event of inner) {
        if (event.type === "done") {
          const billed = await getBilledUsd();
          const msg = (event as any).message;
          if (typeof billed === "number" && Number.isFinite(billed) && billed >= 0 && msg?.usage) {
            applyBilledCostToUsage(msg.usage, billed);
          }
        }
        out.push(event as any);
      }
    } catch {
      // Inner stream failure mid-iteration: end downstream with whatever it saw
    }
    out.end();
    onSettled?.();
  })();
  return out as AssistantMessageEventStream;
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

  const neuralwattModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || resolveBaseUrl() };

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

  // Use pi-ai's per-request fetch option instead of replacing globalThis.fetch.
  // Concurrent main-agent and helper-model requests can finish in either order;
  // a global save/patch/restore stack leaves a stale wrapper installed when they
  // settle out of order. Each call now owns its interceptor and reader.
  let requestBilledUsd: number | undefined;
  let requestTee: Promise<void> | undefined;
  const upstreamFetch = streamOptions.fetch ?? globalThis.fetch;
  const energyFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstreamFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!response.body || !url.includes("/chat/completions")) return response;

    const [bodyForSdk, bodyForEnergy] = response.body.tee();
    const teePromise = readEnergyFromTee(bodyForEnergy, (costUsd) => {
      requestBilledUsd = costUsd;
    });
    requestTee = teePromise;
    trackTeeReader(teePromise);
    return new Response(bodyForSdk, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  const inner = streamOpenAICompletions(neuralwattModel, transformedContext, {
    ...streamOptions,
    fetch: energyFetch,
    reasoningEffort,
    apiKey,
    ...(onPayload ? { onPayload } : {}),
  });

  // Rewrite the committed message's usage.cost to the metered billed cost
  // (flex-discounted when queued) before pi stores it — footers, session
  // totals, and /stats then reflect what's actually billed, in real time.
  const isFlexModel = neuralwattModel.id.endsWith("-flex");
  if (isFlexModel) markLiveFlexStream();
  return wrapStreamWithBilledCost(inner, async () => {
    try { await requestTee; } catch { /* tee already swallows its own errors */ }
    return requestBilledUsd;
  }, isFlexModel ? stopLiveFlexStream : undefined);
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
    baseUrl: resolveBaseUrl(),
    apiKey: "$NEURALWATT_API_KEY",
    api: "neuralwatt" as const,
    models,
    streamSimple: streamNeuralwatt,
    headers: {
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
        refreshFlexPricingMeasurement(cachedApiKey || "", signal);
      }
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("neuralwatt", makeProviderConfig(buildModels(freshBase, customModels, patches, config.modelOverrides)));
        }
      });
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Fetch quota once the run has fully settled (no automatic retry, compaction,
    // or queued continuation can follow) to reflect the updated balance
    if (config.quota !== "off" && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
      const quota = await fetchQuota(cachedApiKey || "");
      if (quota) {
        cachedQuota = quota;
        updateEnergyStatus(ctx);
      }
      refreshFlexPricingMeasurement(cachedApiKey || "");
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
    // Ensure every concurrent response tee has finished before committing.
    await settleTeeReaders();

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
      // Flex telemetry captured from SSE data chunks. The footer badge is
      // sticky (latest-wins): a flex turn sets it, a standard-tier turn
      // clears it.
      if (pendingServiceTier) {
        entry.service_tier = pendingServiceTier;
        if (typeof pendingQueueSeconds === "number") entry.queue_seconds = pendingQueueSeconds;
        if (pendingUsage && ((pendingUsage.prompt ?? 0) > 0 || (pendingUsage.completion ?? 0) > 0)) {
          entry.usage_tokens = {
            prompt: pendingUsage.prompt ?? 0,
            completion: pendingUsage.completion ?? 0,
            cached_input: pendingUsage.cachedInput ?? 0,
          };
        }
        if (pendingServiceTier === "flex") {
          // Fixed per the flex-tier docs (0.65 multiplier → 35% off). The
          // charged amount is energy-derived; do not compare it to token list
          // prices. Consumed (standard-equivalent) cost is recoverable by
          // dividing by the multiplier.
          entry.flex_discount_pct_est = effectiveFlexDiscountPct();
          const consumed = flexConsumedCostUsdEst(pendingCostUsd);
          if (consumed !== undefined) entry.consumed_cost_usd_est = consumed;
          sessionFlexDiscountPct = effectiveFlexDiscountPct();
          sessionFlexQueueSeconds = pendingQueueSeconds;
        } else {
          sessionFlexDiscountPct = undefined;
          sessionFlexQueueSeconds = undefined;
        }
      }
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
        serviceTier: entry.service_tier,
        flexDiscountPctEst: entry.flex_discount_pct_est,
      });

      pendingEnergyJoules = 0;
      pendingCostUsd = 0;
      pendingEnergyRaw = null;
      pendingMcrSessionRaw = null;
      pendingCostRaw = null;
    }
    // Data-chunk telemetry is cleared unconditionally: a flex request aborted
    // mid-queue leaves tier/queue set without any energy/cost, and must not
    // leak into the next request's entry.
    pendingServiceTier = null;
    pendingUsage = null;
    pendingQueueSeconds = undefined;
    // If the session_start quota fetch hasn't landed yet (race), fetch now
    // so the very first turn always shows plan/allowance data.
    if (config.quota !== "off" && !cachedQuota && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
      const quota = await fetchQuota(cachedApiKey || "");
      if (quota) {
        cachedQuota = quota;
      }
      refreshFlexPricingMeasurement(cachedApiKey || "");
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
