#!/usr/bin/env node
/**
 * Update Neuralwatt models from API
 *
 * Fetches models from https://api.neuralwatt.com/v1/models and updates:
 * - models.json: Provider model definitions
 * - README.md: Model table in the Available Models section
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_API_URL = 'https://api.neuralwatt.com/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');
const PATCH_PATH = path.join(__dirname, '..', 'patch.json');

// Known reasoning models by ID pattern
const REASONING_MODEL_PATTERNS = [
  /kimi-k2\.5/i,
  /qwen3\.5/i,
  /gpt-oss/i,
  /devstral/i,
];

// Models known to support vision (image input) - exact IDs only
const VISION_MODEL_IDS = [
  'moonshotai/Kimi-K2.5',
];

// Models that explicitly do NOT have vision despite similar names
const NO_VISION_MODEL_IDS = [
  'kimi-k2.5-fast',
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
 * e.g., "openai/gpt-oss-20b" -> "Neuralwatt: GPT-OSS 20B"
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
    .replace(/Kimi K2\.5/i, 'Kimi K2.5')
    .replace(/Qwen3\.5/i, 'Qwen3.5')
    .replace(/MiniMax M2\.5/i, 'MiniMax M2.5')
    .replace(/Devstral Small 2 24B/i, 'Devstral Small 2 24B');

  return `Neuralwatt: ${displayName}`;
}

/**
 * Estimate pricing based on model characteristics
 * (Neuralwatt API doesn't provide pricing, use estimated values)
 */
function estimatePricing(modelId) {
  const lowerId = modelId.toLowerCase();

  // Fast models are cheaper
  if (lowerId.includes('fast')) {
    if (lowerId.includes('kimi')) return { input: 0.25, output: 1.25 };
    if (lowerId.includes('qwen')) return { input: 0.25, output: 1.25 };
    if (lowerId.includes('glm-5.1')) return { input: 0.48, output: 1.90 };
    if (lowerId.includes('glm-5')) return { input: 0.25, output: 1.10 };
    return { input: 0.30, output: 1.00 };
  }

  // Standard models
  if (lowerId.includes('glm-5.1')) return { input: 0.50, output: 2.10 };
  if (lowerId.includes('glm-5')) return { input: 0.48, output: 1.90 };
  if (lowerId.includes('kimi')) return { input: 0.35, output: 1.70 };
  if (lowerId.includes('minimax')) return { input: 0.11, output: 0.95 };
  if (lowerId.includes('gpt-oss')) return { input: 0.50, output: 1.50 };
  if (lowerId.includes('devstral')) return { input: 0.15, output: 0.45 };
  if (lowerId.includes('qwen3.5-397b')) return { input: 0.35, output: 1.75 };
  if (lowerId.includes('qwen3.5-35b')) return { input: 0.20, output: 0.60 };
  if (lowerId.includes('qwen')) return { input: 0.30, output: 1.00 };

  // Default pricing
  return { input: 0.50, output: 1.50 };
}

/**
 * Transform API model to local format
 */
function transformModel(apiModel) {
  const modelId = apiModel.id;
  const hasReasoning = isReasoningModel(modelId);
  const hasVision = isVisionModel(modelId);
  const pricing = estimatePricing(modelId);

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
      input: pricing.input,
      output: pricing.output,
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

/**
 * Generate README model table
 */
function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Vision | Reasoning | Input $/M | Output $/M |',
    '|-------|---------|--------|-----------|-----------|------------|',
  ];

  for (const model of models) {
    const name = model.name.replace(/^Neuralwatt:\s*/, '');
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
 * Clean model data for JSON output (remove _meta fields)
 */
function cleanModelForJson(model) {
  const { _meta, ...cleanModel } = model;
  return cleanModel;
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

    // Apply patch overrides on top of API-derived data
    for (const model of transformedModels) {
      const overrides = patch[model.id];
      if (overrides) {
        // Deep merge compat, shallow merge everything else
        if (overrides.compat && model.compat) {
          model.compat = { ...model.compat, ...overrides.compat };
          delete overrides.compat;
        }
        Object.assign(model, overrides);
      }
      // Remove thinkingFormat from non-reasoning models
      if (!model.reasoning && model.compat?.thinkingFormat) {
        delete model.compat.thinkingFormat;
      }
      // Remove empty compat leftover
      if (model.compat && Object.keys(model.compat).length === 0) {
        delete model.compat;
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

    // Update models.json (without _meta fields)
    const cleanModels = transformedModels.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + '\n');
    console.log('✓ Updated models.json');

    // Update README.md
    updateReadme(transformedModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${transformedModels.length}`);
    console.log(`Reasoning models: ${transformedModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${transformedModels.filter(m => m.input.includes('image')).length}`);

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
