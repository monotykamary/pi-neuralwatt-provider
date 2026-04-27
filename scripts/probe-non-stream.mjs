#!/usr/bin/env node
/**
 * Neuralwatt Non-Streaming Response Probe
 *
 * Makes a non-streaming request and inspects the JSON response body
 * for any energy/cost/usage metadata.
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL || "moonshotai/Kimi-K2.5";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

async function main() {
  if (!API_KEY) {
    console.error("❌ NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Probing (non-streaming): ${MODEL}\n`);

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Say exactly two words." }],
      max_tokens: 20,
      stream: false,
    }),
  });

  const body = await res.json();

  console.log(`HTTP ${res.status}\n`);
  console.log("--- Full response JSON (pretty) ---");
  console.log(JSON.stringify(body, null, 2));

  // Look for any keys that might contain metadata
  console.log("\n--- Metadata scan ---");
  if (body.usage) {
    console.log("usage:", JSON.stringify(body.usage));
  }
  if (body.energy) {
    console.log("energy:", JSON.stringify(body.energy));
  }
  if (body.cost) {
    console.log("cost:", JSON.stringify(body.cost));
  }
  if (body.system_fingerprint) {
    console.log("system_fingerprint:", body.system_fingerprint);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
