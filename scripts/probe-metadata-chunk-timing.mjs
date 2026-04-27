#!/usr/bin/env node
/**
 * Neuralwatt SSE Metadata — Chunk-by-Chunk Timing
 *
 * Prints each SSE comment with a chunk counter to see if comments appear
 * mid-stream or only at the end.
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL || "moonshotai/Kimi-K2.5";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

async function main() {
  if (!API_KEY) {
    console.error("❌ NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Probing: ${MODEL}\n`);

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Explain quantum computing in simple terms, in 3 paragraphs." }],
      max_tokens: 300,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text();
    console.error(`❌ HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let firstContentText = "";
  let lastContentText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith(": ")) {
          const comment = line.slice(2).trim();
          console.log(`  [chunk ${chunkCount}] COMMENT: ${comment}`);
          // Try to parse if JSON and print nice
          try {
            const obj = JSON.parse(comment);
            const keys = Object.keys(obj).join(", ");
            console.log(`  [chunk ${chunkCount}]       KEYS: ${keys}`);
          } catch {}
        } else if (line.trim().startsWith("data: ")) {
          const payload = line.trim().slice(6);
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload);
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              lastContentText = content;
              if (!firstContentText) {
                firstContentText = content;
                console.log(`  [chunk ${chunkCount}] FIRST_DATA: "${content}" ...`);
              }
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    console.error(`\n💥 Error: ${e.message}`);
  } finally {
    reader.releaseLock();
  }

  console.log(`\n  Total chunks: ${chunkCount}`);
  console.log(`  Last content: "${lastContentText}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
