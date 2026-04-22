#!/usr/bin/env node
/**
 * Vision Model Probe — tests all Neuralwatt models for image support.
 *
 * Sends a chat-completion request with 1 image to each model.
 * Models that accept the image (200) are reported as vision-capable.
 * Models that reject (400) with a vision-related error are non-vision.
 * This helps discover which models have vision/image capabilities upstream.
 *
 * Usage:
 *   export NEURALWATT_API_KEY=your-key
 *   node tests/probe-vision-models.mjs
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

// 1×1 red pixel PNG
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// All models from upstream + custom
const MODELS = [
  "Qwen/Qwen3.6-35B-A3B",
  "moonshotai/Kimi-K2.5",
  "openai/gpt-oss-20b",
  "mistralai/Devstral-Small-2-24B-Instruct-2512",
  "Qwen/Qwen3.5-397B-A17B-FP8",
  "MiniMaxAI/MiniMax-M2.5",
  "zai-org/GLM-5.1-FP8",
  "qwen3.6-35b-fast",
  "kimi-k2.5-fast",
  "glm-5-fast",
  "glm-5.1-fast",
  "qwen3.5-397b-fast",
  "qwen3.5-35b-fast",
  // custom
  "moonshotai/Kimi-K2.6",
  "kimi-k2.6-fast",
];

async function probe(model) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this pixel?" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
            },
          ],
        },
      ],
      max_tokens: 10,
    }),
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  if (!API_KEY) {
    console.error("❌ NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  const vision = [];
  const noVision = [];
  const errors = [];

  for (const model of MODELS) {
    process.stdout.write(`  ${model.padEnd(48)} `);
    try {
      const { ok, status, body } = await probe(model);
      if (ok) {
        console.log(`✅ ${status}`);
        vision.push(model);
      } else {
        // Try to extract detail message
        let detail = "";
        try {
          const parsed = JSON.parse(body);
          detail = parsed.detail || "";
        } catch {
          detail = body?.slice(0, 80) || "";
        }
        const isNotVision =
          /image|vision|unsupported content/i.test(detail) ||
          /does not support/i.test(detail);
        if (isNotVision) {
          console.log(`❌ ${status}  (${detail})`);
          noVision.push({ model, detail });
        } else {
          console.log(`⚠️  ${status}  (${detail})`);
          errors.push({ model, status, detail });
        }
      }
    } catch (e) {
      console.log(`💥 network error: ${e.message}`);
      errors.push({ model, status: "error", detail: e.message });
    }
  }

  console.log(`\n--- Vision-capable (${vision.length}) ---`);
  for (const m of vision) console.log(`  ✅ ${m}`);

  if (noVision.length) {
    console.log(`\n--- Reject images (${noVision.length}) ---`);
    for (const { model, detail } of noVision) console.log(`  ❌ ${model}  ${detail}`);
  }

  if (errors.length) {
    console.log(`\n--- Unclear errors (${errors.length}) ---`);
    for (const { model, status, detail } of errors)
      console.log(`  ⚠️  ${model}  ${status}: ${detail}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
