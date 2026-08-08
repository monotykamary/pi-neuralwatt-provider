#!/usr/bin/env node
/**
 * Update Neuralwatt models from API
 *
 * Fetches models from https://api.neuralwatt.com/v1/models and updates:
 * - models.json: Provider model definitions (with pricing, capabilities, limits from API metadata)
 * - custom-models.json: Exclusive/hidden/preview models not in the API
 * - patch.json: Minimal manual overrides (only for API errors/omissions)
 * - README.md: Model table in the Available Models section
 *
 * Data flow:
 *   API /v1/models        → metadata.pricing, metadata.capabilities, metadata.limits
 *   models.json           → auto-generated from API (all fields from metadata)
 *   patch.json            → manual overrides only where API is wrong or incomplete
 *   custom-models.json    → exclusive/hidden/preview models not in the API
 *
 * Merge order: models.json → apply patch.json → merge custom-models.json
 *
 * The API now provides pricing, reasoning, vision, developer_role, reasoning_effort,
 * max_images, and native reasoning levels (metadata.reasoning) in the metadata
 * field, so patch.json should only hold deliberate deviations from API data.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `neuralwatt` credential in ~/.pi/agent/auth.json wins (the location
 * the README recommends), then the NEURALWATT_API_KEY env var.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.neuralwatt;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.NEURALWATT_API_KEY || undefined;
}

const NEURALWATT_API_KEY = resolveApiKey();
const MODELS_API_URL = 'https://api.neuralwatt.com/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');
const PATCH_PATH = path.join(__dirname, '..', 'patch.json');

/**
 * Generate display name from API metadata.display_name, with fallback to model ID.
 */
function resolveDisplayName(apiModel) {
  const meta = apiModel.metadata || {};
  // Use the API's display_name directly if available
  if (meta.display_name) {
    return meta.display_name;
  }
  // Fallback: generate from model ID
  const parts = apiModel.id.split('/');
  const namePart = parts[parts.length - 1];
  return namePart
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => {
      const acronyms = ['oss', 'fp8', 'a3b', 'a17b', 'it', 'gpt'];
      if (acronyms.includes(word.toLowerCase())) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// pi thinking levels, ordered low→high. "off" is handled separately (it maps
// onto a native "none" effort / omitted effort / hidden, never a named level).
const PI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
function deriveThinkingLevelMap(reasoning) {
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return undefined;

  const supported = Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : [];
  const accepted = Array.isArray(reasoning.accepted_efforts) ? reasoning.accepted_efforts : supported;
  const canonical = new Set(supported.filter((e) => PI_THINKING_LEVELS.includes(e)));
  if (canonical.size === 0) return undefined;

  const map = {};
  if (reasoning.mandatory === true) {
    map.off = null;
  } else if (accepted.includes('none')) {
    map.off = 'none';
  } else if (reasoning.default_enabled !== false) {
    map.off = null;
  }
  for (const level of PI_THINKING_LEVELS) {
    map[level] = canonical.has(level) ? level : null;
  }
  return map;
}

/**
 * Key-order-insensitive equality for thinkingLevelMap entries. Values compare
 * strictly (undefined vs null vs string differ: xhigh/max visibility and the
 * off-wire behavior all hinge on the distinction).
 */
function thinkingLevelMapsEqual(a, b) {
  if (!a || !b) return a === b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/**
 * Transform API model to local format using metadata from the API.
 *
 * The API now provides:
 *   metadata.pricing.input_per_million       → cost.input
 *   metadata.pricing.output_per_million      → cost.output
 *   metadata.pricing.cached_input_per_million → cost.cacheRead
 *   metadata.capabilities.reasoning          → reasoning
 *   metadata.reasoning                       → thinkingLevelMap (see deriveThinkingLevelMap)
 *   metadata.capabilities.vision            → input: ["text", "image"]
 *   metadata.capabilities.developer_role     → compat.supportsDeveloperRole
 *   metadata.capabilities.reasoning_effort   → compat.supportsReasoningEffort
 *   metadata.limits.max_images               → vision.maxImagesPerRequest
 *   metadata.limits.max_context_length       → contextWindow
 *   metadata.limits.max_output_tokens        → maxTokens
 */
function transformModel(apiModel) {
  const meta = apiModel.metadata || {};
  const pricing = meta.pricing || {};
  const caps = meta.capabilities || {};
  const limits = meta.limits || {};

  const hasVision = caps.vision === true;
  const hasReasoning = caps.reasoning === true;

  // Input types
  const inputTypes = ['text'];
  if (hasVision) {
    inputTypes.push('image');
  }

  // Context window and max tokens
  const contextWindow = limits.max_context_length || apiModel.max_model_len || 131072;
  const maxTokens = limits.max_output_tokens || contextWindow;

  // Cost (per million tokens)
  const cost = {
    input: pricing.input_per_million ?? 0,
    output: pricing.output_per_million ?? 0,
    cacheRead: pricing.cached_input_per_million ?? 0,
    cacheWrite: 0, // API doesn't provide cache write pricing
  };

  // Build the model object
  const model = {
    id: apiModel.id,
    name: resolveDisplayName(apiModel),
    reasoning: hasReasoning,
    input: inputTypes,
    cost,
    contextWindow,
    maxTokens,
  };

  // Compat settings (only include non-default values)
  const compat = {};
  if (caps.developer_role === false) {
    compat.supportsDeveloperRole = false;
  }
  if (caps.reasoning_effort === true) {
    compat.supportsReasoningEffort = true;
  }
  if (Object.keys(compat).length > 0) {
    model.compat = compat;
  }

  // Vision settings (only for vision models with a max_images limit)
  if (hasVision && limits.max_images != null) {
    model.vision = { maxImagesPerRequest: limits.max_images };
  }

  // Thinking-level palette from metadata.reasoning (provider-owned since the
  // portal shipped per-model reasoning blocks). patch.json thinkingLevelMap
  // entries still win by replacement — keep them only for deliberate
  // deviations from this derivation.
  if (hasReasoning) {
    const thinkingLevelMap = deriveThinkingLevelMap(meta.reasoning);
    if (thinkingLevelMap) {
      model.thinkingLevelMap = thinkingLevelMap;
    }
  }

  return model;
}

/**
 * Format context window (e.g., 262144 -> "262K")
 */
function formatContextWindow(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

const NESTED_PATCH_KEYS = new Set(['compat', 'vision', 'cost']);

/**
 * Apply overrides from patch.json to a model (mutates model in place).
 * Deep-merges nested objects (compat, vision, cost).
 */
function applyPatchToModel(model, overrides) {
  if (!overrides) return model;
  const result = { ...model };
  for (const [key, value] of Object.entries(overrides)) {
    if (NESTED_PATCH_KEYS.has(key) && typeof value === 'object' && value !== null && typeof result[key] === 'object') {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
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

/**
 * Extract the bespoke overrides from a custom model that has just graduated
 * into the upstream API, so they can be migrated to patch.json (the sync-safe
 * home for per-model overrides) instead of being silently dropped by the
 * duplicate cleanup below.
 *
 * The upstream API is authoritative for pricing, limits, the compat flags
 * it directly exposes (developer_role, reasoning_effort), and — since the
 * portal shipped metadata.reasoning — the thinking-level palette. Only fields
 * the API does NOT express (or expresses differently) are migrated:
 *  - thinkingLevelMap: migrated only when the custom map deviates from what
 *    the API's reasoning block derives (same map → provider-owned, drop it).
 *  - compat: flags absent from, or differing vs, the upstream compat model.
 *  - vision: limits the API doesn't already provide.
 *
 * Returns the patch entry to merge, or undefined if nothing needs migrating.
 */
function extractCustomPatchOverrides(customModel, upstreamModel) {
  const overrides = {};

  if (
    customModel.thinkingLevelMap &&
    Object.keys(customModel.thinkingLevelMap).length > 0 &&
    !thinkingLevelMapsEqual(customModel.thinkingLevelMap, upstreamModel?.thinkingLevelMap)
  ) {
    overrides.thinkingLevelMap = customModel.thinkingLevelMap;
  }

  const upCompat = upstreamModel?.compat ?? {};
  const compatOverrides = {};
  for (const [key, value] of Object.entries(customModel.compat ?? {})) {
    if (!(key in upCompat) || upCompat[key] !== value) {
      compatOverrides[key] = value;
    }
  }
  if (Object.keys(compatOverrides).length > 0) {
    overrides.compat = compatOverrides;
  }

  if (customModel.vision && JSON.stringify(customModel.vision) !== JSON.stringify(upstreamModel?.vision)) {
    overrides.vision = customModel.vision;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Merge a migrated override into an existing patch entry for the same model.
 * Deep-merges nested objects (compat, vision, thinkingLevelMap); replaces
 * scalars. Mirrors the runtime applyPatchToModel semantics.
 */
const MERGE_PATCH_KEYS = new Set(['compat', 'vision', 'thinkingLevelMap']);
function mergePatchEntries(existing, incoming) {
  if (!existing) return incoming;
  const result = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (MERGE_PATCH_KEYS.has(key) && typeof value === 'object' && value !== null && typeof result[key] === 'object') {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatchToModel(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatchToModel(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatchToModel(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }
  return Array.from(modelMap.values());
}

/**
 * Generate README model table
 */
function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Vision | Reasoning | Input $/M | Output $/M |',
    '|-------|---------|--------|-----------|-----------|------------|',
  ];

  for (const model of models) {
    const name = model.name;
    const context = formatContextWindow(model.contextWindow);
    const vision = model.input.includes('image') ? '✅' : '❌';
    const reasoning = model.reasoning ? '✅' : '❌';
    const inputCost = `$${model.cost.input.toFixed(2)}`;
    const outputCost = `$${model.cost.output.toFixed(2)}`;

    lines.push(`| ${name} | ${context} | ${vision} | ${reasoning} | ${inputCost} | ${outputCost} |`);
  }

  return lines.join('\n');
}

/**
 * Update the README.md with new model table
 */
function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');
  const newTable = generateReadmeTable(models);

  const tableRegex = /(## Available Models\n\n)\| Model \|[^\n]+\|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log('✓ Updated README.md');
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

/**
 * Clean model data for models.json output.
 * Keeps the full model spec (pricing, compat, vision) since these now come from the API.
 */
function cleanModelForJson(model) {
  const ALLOWED = ['id', 'name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat', 'vision', 'thinkingLevelMap'];
  const clean = {};
  for (const key of ALLOWED) {
    if (key in model) clean[key] = model[key];
  }
  return clean;
}

/**
 * Clean stale entries from patch.json where the model no longer exists in the
 * upstream API AND is not a custom (hidden) model AND is not sitting in the
 * deprecated-models.json graveyard. Patch entries for custom models are
 * legitimate overrides for models absent from the API, so they must survive
 * syncs. Patch entries for graveyard models must survive too: the runtime
 * keeps serving those models (patch included) for the whole grace period, and
 * a model resurrected upstream should come back with its overrides intact.
 * A patch entry becomes stale exactly when its model does — at eviction.
 *
 * Returns the cleaned patch object.
 */
function cleanStalePatchEntries(patch, upstreamIds, customIds, deprecatedIds, patchPath = PATCH_PATH) {
  const stale = Object.keys(patch).filter(
    id => !upstreamIds.has(id) && !customIds.has(id) && !deprecatedIds.has(id)
  );
  if (stale.length === 0) return patch;

  console.log(`\nStale patch entries (model no longer in API, custom-models.json, or the deprecation grace period):`);
  for (const id of stale) {
    console.log(`  - ${id}`);
  }

  const cleaned = { ...patch };
  for (const id of stale) {
    delete cleaned[id];
  }
  fs.writeFileSync(patchPath, JSON.stringify(cleaned, null, 2) + '\n');
  console.log(`✓ Removed ${stale.length} stale entry/entries from patch.json`);
  return cleaned;
}

/**
 * Main function
 */
// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 * Returns the reconciled graveyard map (post add/resurrect/evict) — main()
 * feeds its ids to cleanStalePatchEntries so a patch entry lives exactly as
 * long as its model's grace period, dying in the same run that evicts it.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map(m => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
  return deprecated;
}

async function main() {
  // Without a key the API answers 200 with only the PUBLIC model list, so an
  // unauthenticated run does not fail: it silently rewrites models.json (and
  // the README table) with every enrollment-gated model missing, and files
  // them all into deprecated-models.json. Refuse to run rather than corrupt
  // the generated files.
  if (!NEURALWATT_API_KEY) {
    console.error(`❌ No API key found: no \`neuralwatt\` entry resolved from ${AUTH_JSON_PATH} and NEURALWATT_API_KEY is not set.`);
    console.error('   Running unauthenticated would silently drop every enrollment-gated model');
    console.error('   (flex variants, MCR long variants, early-access models) from models.json.');
    process.exit(1);
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const headers = { Authorization: `Bearer ${NEURALWATT_API_KEY}` };
    const response = await fetch(MODELS_API_URL, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const apiResponse = await response.json();
    const apiModels = apiResponse.data || apiResponse;

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Transform models using API metadata (pricing, capabilities, limits)
    const transformedModels = apiModels.map(transformModel);

    // Sort models alphabetically by name
    transformedModels.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    // Load existing models for diff
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }

    // Load patch overrides
    let patch = {};
    try {
      patch = JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8'));
      console.log(`✓ Loaded patch with ${Object.keys(patch).length} overrides`);
    } catch (e) {
      console.log('No patch.json found, skipping overrides');
    }

    // Load custom models early so patch entries for hidden models (absent from
    // the API) are preserved during stale cleaning below.
    let customModels = [];
    try {
      customModels = JSON.parse(fs.readFileSync(CUSTOM_MODELS_JSON_PATH, 'utf8'));
      console.log(`✓ Loaded ${customModels.length} custom model(s) from custom-models.json`);
    } catch (e) {
      console.log('No custom-models.json found, skipping custom models');
    }

    // Reconcile the deprecated-models.json graveyard BEFORE cleaning patch
    // entries: a patch entry is stale only when its model is gone from the
    // upstream API, from custom-models.json, AND from the deprecation grace
    // period. updateDeprecatedModels must run before the new models.json is
    // written (it reads the old file itself); running it here also means a
    // newly delisted model's patch entry survives this very sync.
    const cleanModels = transformedModels.map(cleanModelForJson);
    const deprecated = updateDeprecatedModels(MODELS_JSON_PATH, cleanModels);
    const deprecatedIds = new Set(Object.keys(deprecated));

    // Advisory: patch thinkingLevelMap entries vs what the API's reasoning
    // metadata now derives. Matches are removable from patch.json (derivation
    // reproduces them); deviations are deliberate curation (or staleness to
    // review). Pure informational — patch.json always wins at runtime.
    const derivedById = new Map(transformedModels.map(m => [m.id, m.thinkingLevelMap]));
    const matchingMaps = [];
    const deviatingMaps = [];
    for (const [id, entry] of Object.entries(patch)) {
      if (!entry?.thinkingLevelMap) continue;
      const derived = derivedById.get(id);
      if (derived === undefined) continue; // no API block (yet) — patch is the only source
      (thinkingLevelMapsEqual(entry.thinkingLevelMap, derived) ? matchingMaps : deviatingMaps).push(id);
    }
    if (matchingMaps.length > 0 || deviatingMaps.length > 0) {
      console.log('\nPatch thinkingLevelMap vs API-derived (metadata.reasoning):');
      for (const id of matchingMaps) {
        console.log(`  ✓ ${id}: matches derivation — patch entry's map is removable`);
      }
      for (const id of deviatingMaps) {
        console.log(`  ⚠ ${id}: deviates from derivation (kept; patch wins)`);
        console.log(`      patch:   ${JSON.stringify(patch[id].thinkingLevelMap)}`);
        console.log(`      derived: ${JSON.stringify(derivedById.get(id))}`);
      }
    }

    // Clean stale entries from patch.json (hidden models legitimately have
    // patches despite being absent from the API; grace-period models keep
    // theirs until eviction).
    const upstreamIds = new Set(transformedModels.map(m => m.id));
    const customIds = new Set(customModels.map(m => m.id));
    patch = cleanStalePatchEntries(patch, upstreamIds, customIds, deprecatedIds);

    // Log models that still have patch overrides (should be minimal now)
    const remainingPatchCount = Object.keys(patch).length;
    if (remainingPatchCount > 0) {
      console.log(`\nRemaining patch overrides (${remainingPatchCount}):`);
      for (const [id, overrides] of Object.entries(patch)) {
        console.log(`  - ${id}: ${JSON.stringify(overrides)}`);
      }
    } else {
      console.log('\n✓ No patch overrides needed — API metadata is sufficient!');
    }

    // Write models.json (now includes pricing, compat, vision from API)
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json (from API metadata)');

    // Apply patch overrides for merged/README list
    for (const model of transformedModels) {
      applyPatchToModel(model, patch[model.id]);
    }

    // Clean up custom models that now appear in the upstream API.
    // (custom-models.json was loaded above, before stale-patch cleaning.)
    const duplicates = customModels.filter(m => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      const upstreamById = new Map(transformedModels.map(m => [m.id, m]));
      let migratedCount = 0;
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
        const override = extractCustomPatchOverrides(dup, upstreamById.get(dup.id));
        if (override) {
          patch[dup.id] = mergePatchEntries(patch[dup.id], override);
          migratedCount++;
          console.log(`    → migrated overrides to patch.json: ${JSON.stringify(override)}`);
        }
      }
      customModels = customModels.filter(m => !upstreamIds.has(m.id));
      fs.writeFileSync(CUSTOM_MODELS_JSON_PATH, JSON.stringify(customModels, null, 2) + '\n');
      fs.writeFileSync(PATCH_PATH, JSON.stringify(patch, null, 2) + '\n');
      console.log(
        `✓ Removed ${duplicates.length} duplicate(s) from custom-models.json (${migratedCount} migrated to patch.json)`,
      );
    }

    // Build merged list: base → patch → custom (custom takes precedence on overlap)
    const allModels = buildModels(transformedModels, customModels, patch);
    console.log(
      `Total: ${allModels.length} models (${transformedModels.length} upstream + ${customModels.length} custom)`
    );

    // Update README.md with merged model list
    updateReadme(allModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${allModels.length}`);
    console.log(`Reasoning models: ${allModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${allModels.filter(m => m.input.includes('image')).length}`);

    const newIds = new Set(transformedModels.map(m => m.id));
    const oldIds = new Set(existingModels.map(m => m.id));

    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    if (added.length > 0) {
      console.log(`\nNew models: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      console.log(`\nRemoved models: ${removed.join(', ')}`);
    }

    // Diff pricing for existing models
    const oldModelMap = new Map(existingModels.map(m => [m.id, m]));
    const pricingChanged = transformedModels.filter(m => {
      const old = oldModelMap.get(m.id);
      if (!old) return false;
      return old.cost.input !== m.cost.input || old.cost.output !== m.cost.output;
    });
    if (pricingChanged.length > 0) {
      console.log(`\nPricing changes:`);
      for (const m of pricingChanged) {
        const old = oldModelMap.get(m.id);
        console.log(`  ${m.id}: $${old.cost.input}/$${old.cost.output} → $${m.cost.input}/$${m.cost.output}`);
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run only when invoked directly (node scripts/update-models.js). Tests import
// the helpers below and must not trigger network I/O or file rewrites.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}

export {
  cleanStalePatchEntries,
  updateDeprecatedModels,
  extractCustomPatchOverrides,
  mergePatchEntries,
  deriveThinkingLevelMap,
  thinkingLevelMapsEqual,
  transformModel,
  cleanModelForJson,
};
