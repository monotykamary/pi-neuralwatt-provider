#!/usr/bin/env node
/**
 * Neuralwatt Response Headers Probe
 * Check for any x- headers with metadata (rate limits, energy headers, etc.)
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL || "moonshotai/Kimi-K2.5";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

async function main() {
  if (!API_KEY) { console.error("❌ NEURALWATT_API_KEY needed"); process.exit(1); }

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
      stream: false,
    }),
  });

  console.log(`HTTP ${res.status} ${res.statusText}\n`);
  console.log("--- Response Headers ---");
  for (const [k, v] of res.headers) {
    console.log(`  ${k}: ${v}`);
  }

  // Check for x-energy, x-rate-limit, etc.
  const body = await res.json();
  console.log("\n--- BODY metadata keys ---");
  console.log(  Object.keys(body).filter(k => !['id','object','created','model','choices','prompt_logprobs','prompt_token_ids','kv_transfer_params','service_tier','system_fingerprint'].includes(k)));
}

main().catch(console.error);
