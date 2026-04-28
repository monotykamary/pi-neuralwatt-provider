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
 * and max_images in the metadata field, so patch.json should be mostly empty.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Transform API model to local format using metadata from the API.
 *
 * The API now provides:
 *   metadata.pricing.input_per_million       → cost.input
 *   metadata.pricing.output_per_million      → cost.output
 *   metadata.pricing.cached_input_per_million → cost.cacheRead
 *   metadata.capabilities.reasoning          → reasoning
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
  if (!overrides) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (NESTED_PATCH_KEYS.has(key) && typeof value === 'object' && value !== null && typeof model[key] === 'object') {
      model[key] = { ...model[key], ...value };
    } else {
      model[key] = value;
    }
  }
  // Clean up: don't leave thinkingFormat on non-reasoning models
  if (!model.reasoning && model.compat?.thinkingFormat) {
    delete model.compat.thinkingFormat;
  }
  if (model.compat && Object.keys(model.compat).length === 0) {
    delete model.compat;
  }
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
  const ALLOWED = ['id', 'name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat', 'vision'];
  const clean = {};
  for (const key of ALLOWED) {
    if (key in model) clean[key] = model[key];
  }
  return clean;
}

/**
 * Clean stale entries from patch.json where the model no longer exists in the API.
 * Returns the cleaned patch object.
 */
function cleanStalePatchEntries(patch, upstreamIds) {
  const stale = Object.keys(patch).filter(id => !upstreamIds.has(id));
  if (stale.length === 0) return patch;

  console.log(`\nStale patch entries (model no longer in API):`);
  for (const id of stale) {
    console.log(`  - ${id}`);
  }

  const cleaned = { ...patch };
  for (const id of stale) {
    delete cleaned[id];
  }
  fs.writeFileSync(PATCH_PATH, JSON.stringify(cleaned, null, 2) + '\n');
  console.log(`✓ Removed ${stale.length} stale entry/entries from patch.json`);
  return cleaned;
}

/**
 * Main function
 */
async function main() {
  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const response = await fetch(MODELS_API_URL);
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

    // Clean stale entries from patch.json
    const upstreamIds = new Set(transformedModels.map(m => m.id));
    patch = cleanStalePatchEntries(patch, upstreamIds);

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
    const cleanModels = transformedModels.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json (from API metadata)');

    // Apply patch overrides for merged/README list
    for (const model of transformedModels) {
      applyPatchToModel(model, patch[model.id]);
    }

    // ── Load and merge custom models ──────────────────────────────────
    let customModels = [];
    try {
      customModels = JSON.parse(fs.readFileSync(CUSTOM_MODELS_JSON_PATH, 'utf8'));
      console.log(`✓ Loaded ${customModels.length} custom model(s) from custom-models.json`);
    } catch (e) {
      console.log('No custom-models.json found, skipping custom models');
    }

    // Clean up custom models that now appear in the upstream API
    const duplicates = customModels.filter(m => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      customModels = customModels.filter(m => !upstreamIds.has(m.id));
      fs.writeFileSync(CUSTOM_MODELS_JSON_PATH, JSON.stringify(customModels, null, 2) + '\n');
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
    }

    // Build merged list: upstream + custom (custom takes precedence on overlap)
    const mergedMap = new Map();
    for (const model of transformedModels) {
      mergedMap.set(model.id, model);
    }
    for (const model of customModels) {
      applyPatchToModel(model, patch[model.id]);
      mergedMap.set(model.id, model);
    }
    const allModels = Array.from(mergedMap.values());
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

main();
