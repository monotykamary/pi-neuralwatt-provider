#!/usr/bin/env node
/**
 * Neuralwatt SSE Metadata Probe
 *
 * Makes a streaming chat completion and prints EVERY SSE comment line
 * (: energy, : cost, and any others) to discover all metadata sent.
 *
 * Usage:
 *   export NEURALWATT_API_KEY=your-key
 *   MODEL=moonshotai/Kimi-K2.5 node test-metadata-stream.mjs
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL   = process.env.MODEL || "moonshotai/Kimi-K2.5";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

async function main() {
  if (!API_KEY) {
    console.error("❌ NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Probing model: ${MODEL}\n`);

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
  const comments = [];
  const seenEvent = new Set();
  let inData = false;
  let textChunks = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith(": ")) {
          const comment = line.slice(2).trim();
          comments.push(comment);

          // Unique ones for summary
          if (!seenEvent.has(comment)) {
            seenEvent.add(comment);
          }
        } else if (line.trim().startsWith("data: ")) {
          textChunks++;
          // Quick count to show it was streaming normally
          if (textChunks <= 3) {
            const payload = line.trim().slice(6);
            if (!payload.includes("[DONE]")) {
              try {
                const pr = JSON.parse(payload);
                const content = pr.choices?.[0]?.delta?.content;
                if (content) process.stdout.write(`DATA: "${content}"\n`);
              } catch {}
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`\n💥 Error reading stream: ${e.message}`);
  } finally {
    reader.releaseLock();
  }

  // Deduplicate structured comments by their JSON key (rough)
  const uniquePatterns = new Set();
  const structuredComments = [];
  for (const c of seenEvent) {
    try {
      const obj = JSON.parse(c);
      const key = Object.keys(obj).sort().join("|");
      if (!uniquePatterns.has(key)) {
        uniquePatterns.add(key);
        structuredComments.push(obj);
      }
    } catch {
      uniquePatterns.add(c);
      structuredComments.push(c);
    }
  }

  console.log(`\n\n🗂️  Total comment lines: ${comments.length}`);
  console.log(`🔑 Unique comment patterns: ${uniquePatterns.size}\n`);

  console.log("--- Unique Comment Structures ---");
  for (const item of structuredComments) {
    if (typeof item === "string") {
      console.log(`  : ${item}`);
    } else {
      console.log(`  : ${JSON.stringify(item)}`);
    }
  }

  console.log("\n--- Full comment log (chronological) ---");
  for (const c of comments) {
    console.log(`  : ${c}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
