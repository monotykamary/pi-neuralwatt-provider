#!/usr/bin/env node
/**
 * Neuralwatt Vision Image-Limit Harness
 *
 * Sends chat-completion requests with an increasing number of images
 * in a single user message until the API returns a non-2xx status.
 *
 * Usage:
 *   export NEURALWATT_API_KEY=your-key
 *   node test-image-limit.mjs
 *
 * Env:
 *   MODEL        – model id (default: moonshotai/Kimi-K2.5)
 *   MAX_IMAGES   – upper bound to test (default: 30)
 *   STEP         – how many images to add each round (default: 1)
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL        || "moonshotai/Kimi-K2.5";
const MAX     = parseInt(process.env.MAX_IMAGES || "30", 10);
const STEP    = parseInt(process.env.STEP        || "1", 10);

const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

// 1×1 red pixel PNG
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function send(nImages) {
  const content = [
    { type: "text", text: "What color is this pixel?" },
    ...Array.from({ length: nImages }, () => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
    })),
  ];

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 10,
    }),
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  if (!API_KEY) {
    console.error("❌  NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Testing model: ${MODEL}\n`);

  let lastOk = 0;

  for (let n = STEP; n <= MAX; n += STEP) {
    process.stdout.write(`  ${n.toString().padStart(2)} images … `);
    const { ok, status, body } = await send(n);

    if (ok) {
      console.log(`✅  ${status}`);
      lastOk = n;
    } else {
      console.log(`❌  ${status}`);
      // Pretty-print body if it's JSON, otherwise raw
      try {
        const parsed = JSON.parse(body);
        console.log("      Body:", JSON.stringify(parsed, null, 2).split("\n").join("\n      "));
      } catch {
        console.log("      Body:", body || "(empty)");
      }
      console.log(`\n➡️  Limit appears to be ${lastOk} image(s).`);
      process.exit(0);
    }
  }

  console.log(`\n➡️  Reached MAX_IMAGES (${MAX}) without failure. Limit is ≥ ${MAX}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
