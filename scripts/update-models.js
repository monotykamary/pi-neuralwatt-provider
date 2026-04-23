#!/usr/bin/env node
/**
 * Update Neuralwatt models from API
 *
 * Fetches models from https://api.neuralwatt.com/v1/models and updates:
 * - models.json: Provider model definitions
 * - custom-models.json: Exclusive/hidden/preview models not in the API
 * - README.md: Model table in the Available Models section
 *
 * Data flow:
 *   models.json         → auto-generated from Neuralwatt API (model discovery)
 *   patch.json          → manual overrides (pricing, reasoning, limits, etc.)
 *   custom-models.json  → exclusive/hidden/preview models not in the API
 *
 * Merge order: models.json → apply patch.json → merge custom-models.json
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

// Known reasoning models by ID pattern
const REASONING_MODEL_PATTERNS = [
  /kimi-k2\.[56]/i,
  /qwen3\.5/i,
  /gpt-oss/i,
  /devstral/i,
];

// Models known to support vision (image input) - exact IDs only
const VISION_MODEL_IDS = [
  'moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2.6',
];

// Models that explicitly do NOT have vision despite similar names
const NO_VISION_MODEL_IDS = [
  'kimi-k2.5-fast',
  'kimi-k2.6-fast',
];

/**
 * Check if a model ID indicates reasoning capability
 */
function isReasoningModel(modelId) {
  const lowerId = modelId.toLowerCase();
  return REASONING_MODEL_PATTERNS.some(pattern => pattern.test(lowerId));
}

/**
 * Check if a model ID indicates vision capability
 */
function isVisionModel(modelId) {
  const lowerId = modelId.toLowerCase();
  // Explicit exclusions first
  if (NO_VISION_MODEL_IDS.some(id => lowerId === id.toLowerCase())) {
    return false;
  }
  // Exact ID matches for vision support
  return VISION_MODEL_IDS.some(id => lowerId === id.toLowerCase());
}

/**
 * Generate display name from model ID
 * e.g., "openai/gpt-oss-20b" -> "GPT-OSS 20B"
 */
function generateDisplayName(modelId) {
  // Remove organization prefix
  const parts = modelId.split('/');
  const namePart = parts[parts.length - 1];

  // Convert to readable format
  let displayName = namePart
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => {
      // Keep known acronyms uppercase
      const acronyms = ['oss', 'fp8', 'a3b', 'a17b', 'it', 'gpt'];
      if (acronyms.includes(word.toLowerCase())) {
        return word.toUpperCase();
      }
      // Capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');

  // Special cases for better naming
  displayName = displayName
    .replace(/GLM 5\.1 FP8/i, 'GLM 5.1 FP8')
    .replace(/Kimi K2\.[56]/i, (m) => m) // preserve K2.5, K2.6
    .replace(/Qwen3\.5/i, 'Qwen3.5')
    .replace(/MiniMax M2\.5/i, 'MiniMax M2.5')
    .replace(/Devstral Small 2 24B/i, 'Devstral Small 2 24B');

  return displayName;
}

/**
 * Transform API model to local format.
 * Pricing comes from patch.json, not from the API.
 */
function transformModel(apiModel) {
  const modelId = apiModel.id;
  const hasReasoning = isReasoningModel(modelId);
  const hasVision = isVisionModel(modelId);

  // Determine input types
  const inputTypes = ['text'];
  if (hasVision) {
    inputTypes.push('image');
  }

  // Use max_model_len from API or fallback
  const contextWindow = apiModel.max_model_len || 131072;
  const maxTokens = apiModel.max_completion_tokens || contextWindow;

  return {
    id: modelId,
    name: generateDisplayName(modelId),
    reasoning: hasReasoning,
    input: inputTypes,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: contextWindow,
    maxTokens: maxTokens,
    // Metadata for README generation
    _meta: {
      quantization: apiModel.quantization,
    },
  };
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
 * Deep-merges nested objects (compat, vision, cost) and removes
 * thinkingFormat from non-reasoning models.
 */
function applyPatchToModel(model, overrides) {
  if (!overrides) return;
  const cloned = { ...overrides };
  for (const [key, value] of Object.entries(cloned)) {
    if (NESTED_PATCH_KEYS.has(key) && typeof value === 'object' && value !== null && typeof model[key] === 'object') {
      model[key] = { ...model[key], ...value };
    } else {
      model[key] = value;
    }
  }
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

  // Find and replace the model table within the Available Models section
  // Match the table header row and all subsequent table rows (lines starting with |)
  // Also capture trailing newlines to preserve spacing
  const tableRegex = /(## Available Models\n\n)\| Model \|[^\n]+\|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    // Use a replacer function to avoid $ being interpreted as regex group reference
    // Add single blank line after table (standard markdown spacing before next heading)
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log('✓ Updated README.md');
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

/**
 * Clean model data for JSON output.
 * Keeps only API-derived fields; strips any patch/runtime fields
 * to ensure models.json stays API-pure.
 */
function cleanModelForJson(model) {
  const ALLOWED = ['id', 'name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens'];
  const clean = {};
  for (const key of ALLOWED) {
    if (key in model) clean[key] = model[key];
  }
  return clean;
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
    const apiModels = apiResponse.data || apiResponse; // Handle both {data: [...]} and direct array

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Load patch overrides
    let patch = {};
    try {
      patch = JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8'));
      console.log(`✓ Loaded patch with ${Object.keys(patch).length} overrides`);
    } catch (e) {
      console.log('No patch.json found, skipping overrides');
    }

    // Transform models
    const transformedModels = apiModels.map(transformModel);

    // Log new models missing from patch.json (they'll have zero pricing)
    for (const model of transformedModels) {
      if (!patch[model.id]) {
        console.log(`  🆕 New model: ${model.id} (${model.name}) — add to patch.json for pricing/overrides`);
      }
    }

    // Sort models alphabetically by name
    transformedModels.sort((a, b) => {
      const nameA = a.name.toLowerCase();
      const nameB = b.name.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    // Load existing models for comparison
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }

    // Write models.json with raw API-derived data (no patches baked in)
    // Patches are applied at runtime by the provider (buildModelList in index.ts)
    const cleanModels = transformedModels.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json (API-pure, no patches)');

    // Apply patch overrides for merged/README list only
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
    const upstreamIds = new Set(transformedModels.map(m => m.id));
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
    // Apply patch overrides on custom models too
    for (const model of customModels) {
      if (patch[model.id]) {
        applyPatchToModel(model, patch[model.id]);
      } else {
        console.log(`  ⚠ Custom model ${model.id} has no patch entry — add to patch.json for pricing/overrides`);
      }
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

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
