#!/usr/bin/env node
/**
 * Check headers on a streaming response.
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
      stream: true,
    }),
  });

  console.log(`HTTP ${res.status} ${res.statusText}\n`);

  // Helper to get all kebab-case headers
  const headers = [...res.headers.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [k, v] of headers) {
    console.log(`  ${k}: ${v}`);
  }

  // Consume body just to tidy up
  if (res.body) {
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
  }
}

main().catch(console.error);
