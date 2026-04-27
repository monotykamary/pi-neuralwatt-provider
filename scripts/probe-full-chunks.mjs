#!/usr/bin/env node
/**
 * Print EVERY data chunk to inspect full structure (reasoning, usage, etc.)
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
      messages: [{ role: "user", content: "What is 2+2?" }],
      max_tokens: 100,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) { console.error("❌", res.status, await res.text()); process.exit(1); }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let n = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n++;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().startsWith("data: ")) {
        const payload = line.trim().slice(6);
        if (payload === "[DONE]") { console.log(`[chunk ${n}] [DONE]`); continue; }
        try {
          const obj = JSON.parse(payload);
          console.log(`[chunk ${n}] ${JSON.stringify(obj)}`);
        } catch {
          console.log(`[chunk ${n}] (unparseable) ${payload}`);
        }
      }
    }
  }
  console.log(`\nTotal: ${n} chunks`);
}

main().catch(console.error);
