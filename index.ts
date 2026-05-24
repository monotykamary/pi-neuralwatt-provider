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
 *     "energy": "widget",   // "widget" | "statusbar" | "off"
 *     "quota": "widget"      // "widget" | "statusbar" | "off"
 *   }
 *
 *   - "widget" (default): rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (for quota, also skips the API fetch)
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

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamOpenAICompletions } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchesData from "./patch.json" with { type: "json" };
import { transformContextForImageLimit } from "./transform";
import fs from "fs";
import os from "os";
import path from "path";

// ─── Display Configuration ────────────────────────────────────────────────────

type DisplayMode = "widget" | "statusbar" | "off";

interface NeuralwattConfig {
  energy: DisplayMode;
  quota: DisplayMode;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "neuralwatt.json");

const VALID_DISPLAY_MODES = new Set<string>(["widget", "statusbar", "off"]);

function parseDisplayMode(value: unknown, fallback: DisplayMode): DisplayMode {
  if (typeof value === "string" && VALID_DISPLAY_MODES.has(value)) return value as DisplayMode;
  return fallback;
}

const DEFAULT_CONFIG: NeuralwattConfig = { energy: "widget", quota: "widget" };

function loadConfig(): NeuralwattConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      energy: parseDisplayMode(raw.energy, "widget"),
      quota: parseDisplayMode(raw.quota, "widget"),
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

let config = loadConfig();

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
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
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
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }
  return result;
}

/** Full pipeline: base → patch → custom → result */
function buildModels(
  base: NeuralwattModel[],
  custom: NeuralwattModel[],
  patchList: Record<string, any>,
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
const BASE_URL = "https://api.neuralwatt.com/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
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
      result.push({
        ...liveModel,
        ...embedded,
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
  energy_kwh?: number;
  avg_power_watts?: number;
  duration_seconds?: number;
  attribution_method?: string;
  attribution_ratio?: number;
  ratio_was_capped?: boolean;
  uncapped_attribution_ratio?: number;
  uncapped_energy_joules?: number;
  uncapped_energy_kwh?: number;
  cache_savings_usd?: number;
  allowance_remaining_usd?: number;
  budget_remaining_usd?: number;
}

const ENERGY_ENTRY_TYPE = "neuralwatt-energy";
const STATUS_KEY_ENERGY = "neuralwatt-energy";
const STATUS_KEY_QUOTA = "neuralwatt-quota";

let sessionEnergyJoules = 0;
let sessionCostUsd = 0;
let pendingEnergyJoules = 0;
let pendingCostUsd = 0;
let pendingDetail: Partial<EnergyEvent> = {};
let teeReader: Promise<void> | undefined;

// Exposed for testing
export function getPendingState() {
  return { pendingEnergyJoules, pendingCostUsd, pendingDetail, teeReader };
}

export function resetSessionState() {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
  pendingDetail = {};
}

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

function buildEnergyStatusText(): string | undefined {
  if (sessionEnergyJoules <= 0 && sessionCostUsd <= 0) return undefined;
  const energyStr = formatEnergy(sessionEnergyJoules);
  const costStr = formatCost(sessionCostUsd);
  return `⚡${energyStr} ${costStr}`;
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

function buildQuotaStatusText(): string | undefined {
  if (!cachedQuota) return undefined;
  const q = cachedQuota;
  const parts: string[] = [];

  if (q.subscription) {
    // Plan name
    parts.push(q.subscription.plan);

    // Status indicator
    if (q.subscription.status === "active") {
      parts.push("●");
    } else if (q.subscription.status === "past_due" || q.subscription.status === "paused") {
      parts.push("⊘");
    } else {
      parts.push(`●${q.subscription.status}`);
    }

    // kWh allocation
    if (q.subscription.kwh_included != null && q.subscription.kwh_remaining != null) {
      const kwhUsed = q.subscription.kwh_used ?? 0;
      parts.push(`${formatKwh(q.subscription.kwh_remaining)}/${formatKwh(q.subscription.kwh_included)} kWh`);
      if (q.subscription.in_overage) {
        parts.push("⚠");
      }
    }
  } else {
    // Pay-as-you-go: no subscription
    parts.push("payg");
  }

  // Credits remaining
  parts.push(`∙ ${formatCost(q.balance.credits_remaining_usd)}`);

  // Key allowance (if set)
  if (q.key.allowance) {
    const a = q.key.allowance;
    const spent = a.limit_usd - a.remaining_usd;
    const periodLabel = { daily: "d", weekly: "wk", monthly: "mo" }[a.period] ?? a.period;
    parts.push(`∙ ⚷ ${formatCost(spent)}/${formatCost(a.limit_usd)}/${periodLabel}`);
    if (a.blocked) {
      parts.push("⊘");
    }
  }

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
    const char = str[i];
    if (EMOJI_RE.test(char)) {
      width += 2;
      i++;
    } else if (AMBIGUOUS_WIDE.has(char)) {
      width += 2;
      i++;
    } else {
      width += 1;
      i++;
    }
  }
  return width;
}

// Custom Component that renders our status line directly, bypassing pi-tui's
// Text auto-padding (which caused wrap/spacing bugs from visibleWidth mismatches
// on emoji and ambiguous-width characters).
// Defers padding to render(width) so it adapts to terminal resizes.
class StatusLineWidget {
  private left: string;
  private right: string | undefined;

  constructor(left: string, right?: string) {
    this.left = left;
    this.right = right;
  }

  render(width: number): string[] {
    if (this.right) {
      const leftVis = termVisWidth(this.left);
      const rightVis = termVisWidth(this.right);
      const pad = Math.max(1, width - leftVis - rightVis);
      return [this.left + " ".repeat(pad) + this.right];
    }
    return [this.left];
  }
}

function updateEnergyStatus(ctx: any): void {
  // Only show the status line when there is neuralwatt activity in this session.
  // This avoids showing quota/energy data in sessions that use a different provider.
  const hasNeuralwattSession = sessionEnergyJoules > 0 || sessionCostUsd > 0;

  const energyText = hasNeuralwattSession ? buildEnergyStatusText() : undefined;
  const quotaText = hasNeuralwattSession ? buildQuotaStatusText() : undefined;

  // ─── Status bar ─────────────────────────────────────────────────────────
  // When both energy and quota are in statusbar mode, combine them into one
  // entry with a " | " separator. Otherwise use separate keys.
  const energyStatusbar = config.energy === "statusbar" && energyText;
  const quotaStatusbar = config.quota === "statusbar" && quotaText;

  if (energyStatusbar && quotaStatusbar) {
    const combined = ctx.ui.theme.fg("dim", energyText! + " | " + quotaText!);
    ctx.ui.setStatus(STATUS_KEY_ENERGY, combined);
    ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
  } else {
    if (energyStatusbar) {
      ctx.ui.setStatus(STATUS_KEY_ENERGY, ctx.ui.theme.fg("dim", energyText!));
    } else {
      ctx.ui.setStatus(STATUS_KEY_ENERGY, undefined);
    }
    if (quotaStatusbar) {
      ctx.ui.setStatus(STATUS_KEY_QUOTA, ctx.ui.theme.fg("dim", quotaText!));
    } else {
      ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
    }
  }

  // ─── Widget assembly ─────────────────────────────────────────────────────
  // The below-editor widget uses the original left-right layout with
  // energy on the left and quota on the right, padded to terminal width.
  const showEnergyWidget = config.energy === "widget" && energyText;
  const showQuotaWidget = config.quota === "widget" && quotaText;

  if (showEnergyWidget || showQuotaWidget) {
    const left = ctx.ui.theme.fg("dim", energyText ?? "");
    const right = showEnergyWidget && showQuotaWidget ? ctx.ui.theme.fg("dim", quotaText!) : undefined;
    const leftOnly = !showEnergyWidget && showQuotaWidget ? ctx.ui.theme.fg("dim", quotaText!) : undefined;
    if (leftOnly) {
      ctx.ui.setWidget(
        "neuralwatt",
        (_ui: any, _theme: any) => new StatusLineWidget(leftOnly),
        { placement: "belowEditor" },
      );
    } else {
      ctx.ui.setWidget(
        "neuralwatt",
        (_ui: any, _theme: any) => new StatusLineWidget(left, right),
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

function streamNeuralwatt(
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
      ...options,
      apiKey,
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

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as NeuralwattModel[];
  const customModels = customModelsData as NeuralwattModel[];
  const patches = patchesData as Record<string, any>;

  // SWR: Serve stale immediately (cache → embedded)
  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "NEURALWATT_API_KEY",
    api: "neuralwatt",
    models: staleModels,
    streamSimple: streamNeuralwatt,
  });

  // Revalidate in background on session_start
  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    config = loadConfig();
    resetSessionState();
    cachedQuota = null;
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
    resolveApiKey(ctx.modelRegistry).then(() => {
      if (config.quota !== "off" && (sessionEnergyJoules > 0 || sessionCostUsd > 0)) {
        fetchQuota(cachedApiKey || "", signal).then((quota) => {
          if (quota && !signal.aborted) {
            cachedQuota = quota;
            updateEnergyStatus(ctx);
          }
        });
      }
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("neuralwatt", {
            baseUrl: BASE_URL,
            apiKey: "NEURALWATT_API_KEY",
            api: "neuralwatt",
            models: buildModels(freshBase, customModels, patches),
            streamSimple: streamNeuralwatt,
          });
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
    cachedQuota = null;
    // Clear any status bar entries from energy/quota display modes.
    // (widget cleanup is handled by the extension runtime teardown)
    ctx.ui.setStatus(STATUS_KEY_ENERGY, undefined);
    ctx.ui.setStatus(STATUS_KEY_QUOTA, undefined);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Ensure the energy tee reader has finished before committing.
    if (teeReader) {
      try {
        await teeReader;
      } catch {
        // Tee stream may error if the main stream was aborted
      }
      teeReader = undefined;
    }

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
}
