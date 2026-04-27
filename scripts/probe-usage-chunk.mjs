#!/usr/bin/env node
/**
 * Check for usage/finish chunks in Neuralwatt SSE stream.
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL || "moonshotai/Kimi-K2.5";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

async function main() {
  if (!API_KEY) { console.error("❌ NEURALWATT_API_KEY needed"); process.exit(1); }

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Say two words." }],
      max_tokens: 20,
      stream: true,
      stream_options: { include_usage: true },  // OpenAI option
    }),
  });

  if (!res.ok || !res.body) {
    console.error(`❌ ${res.status} ${await res.text()}`);
    process.exit(1);
  }

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
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.usage !== undefined || obj.choices?.[0]?.finish_reason !== null) {
            console.log(`[chunk ${n}] data: ${JSON.stringify(obj)}`);
          }
          if (obj.choices?.[0]?.finish_reason) {
            console.log(`[chunk ${n}] FINISH: "${obj.choices[0].finish_reason}"`);
          }
          if (obj.usage) {
            console.log(`[chunk ${n}] USAGE: ${JSON.stringify(obj.usage)}`);
          }
        } catch {}
      }
    }
  }
  console.log(`Total chunks: ${n}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
