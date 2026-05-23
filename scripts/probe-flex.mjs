#!/usr/bin/env node
/**
 * Neuralwatt Flex Model Probe
 *
 * Tests a flex model endpoint by measuring:
 *   - Time to first token (TTFT)
 *   - Time to first content token
 *   - Total response time
 *   - SSE comment metadata (energy, cost, quota-like fields)
 *   - Full chunk structure (reasoning, content, usage)
 *
 * Flex models have variable latency — responses may be instant or take
 * up to an hour depending on capacity. This probe captures timing details
 * and all SSE metadata.
 *
 * Usage:
 *   MODEL=glm-5.1-flex node scripts/probe-flex.mjs
 *   MODEL=kimi-k2.6-flex node scripts/probe-flex.mjs
 */

const API_KEY = process.env.NEURALWATT_API_KEY;
const MODEL = process.env.MODEL || "glm-5.1-flex";
const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 120_000;

async function main() {
  if (!API_KEY) {
    console.error("❌ NEURALWATT_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`┌─ Flex Model Probe ─────────────────────────────`);
  console.log(`│ Model:     ${MODEL}`);
  console.log(`│ Timeout:   ${TIMEOUT_MS / 1000}s`);
  console.log(`│ Time:      ${new Date().toISOString()}`);
  console.log(`└────────────────────────────────────────────────\n`);

  const t0 = performance.now();
  let ttfb = null;
  let ttft = null;
  let ttFirstContent = null;
  let tLastChunk = null;
  let totalChunks = 0;
  let contentChunks = 0;
  let reasoningChunks = 0;
  let usageChunks = 0;
  let doneChunks = 0;
  let comments = [];
  let fullContent = "";
  let fullReasoning = "";
  let usage = null;
  let firstChunkType = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "What is 2+2? Answer briefly." }],
        max_tokens: 200,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    console.error(`❌ Connection failed (${(performance.now() - t0).toFixed(0)}ms): ${e.message}`);
    process.exit(1);
  }

  clearTimeout(timeout);
  ttfb = performance.now() - t0;

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ HTTP ${res.status} ${res.statusText} (${ttfb.toFixed(0)}ms)`);
    console.error(body);
    process.exit(1);
  }

  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log(`TTFB: ${ttfb.toFixed(0)}ms\n`);

  if (!res.body) {
    console.error("❌ No response body");
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalChunks++;
      const now = performance.now();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // SSE comments (energy, cost, etc.)
        if (trimmed.startsWith(": ")) {
          const comment = trimmed.slice(2);
          comments.push({ t: now - t0, raw: comment });
          try {
            const obj = JSON.parse(comment);
            const key = Object.keys(obj)[0] || "";
            const label = key.replace(/_/g, " ");
            console.log(`  ⏱ +${(now - t0).toFixed(0)}ms  : ${label} {${Object.keys(obj).join(", ")}}`);
          } catch {
            console.log(`  ⏱ +${(now - t0).toFixed(0)}ms  : ${comment}`);
          }
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          doneChunks++;
          tLastChunk = now - t0;
          console.log(`  ⏱ +${tLastChunk.toFixed(0)}ms  [DONE]`);
          continue;
        }

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = obj.choices?.[0]?.delta;
        if (delta) {
          // First token timing
          if (ttft === null) {
            ttft = now - t0;
            console.log(`\n  ⚡ TTFT: ${ttft.toFixed(0)}ms (first SSE data chunk)\n`);
          }

          // Reasoning content
          if (delta.reasoning_content || delta.thinking) {
            reasoningChunks++;
            if (firstChunkType === null) firstChunkType = "reasoning";
            const rc = delta.reasoning_content || delta.thinking || "";
            fullReasoning += rc;
            if (reasoningChunks <= 3) {
              const preview = rc.length > 80 ? rc.slice(0, 80) + "…" : rc;
              console.log(`  ⏱ +${(now - t0).toFixed(0)}ms  [reasoning #${reasoningChunks}] "${preview}"`);
            }
          }

          // Text content
          if (delta.content) {
            contentChunks++;
            if (firstChunkType === null && !delta.reasoning_content && !delta.thinking) {
              firstChunkType = "content";
            }
            if (ttFirstContent === null) {
              ttFirstContent = now - t0;
              console.log(`\n  ⚡ First content token: ${ttFirstContent.toFixed(0)}ms\n`);
            }
            fullContent += delta.content;
            if (contentChunks <= 5) {
              process.stdout.write(delta.content);
            }
          }

          // Tool calls
          if (delta.tool_calls) {
            console.log(`  ⏱ +${(now - t0).toFixed(0)}ms  [tool_call] ${JSON.stringify(delta.tool_calls)}`);
          }
        }

        // Usage
        if (obj.usage) {
          usageChunks++;
          usage = obj.usage;
          console.log(`\n  ⏱ +${(now - t0).toFixed(0)}ms  [usage] prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
          if (usage.prompt_tokens_details) {
            console.log(`           prompt_details: ${JSON.stringify(usage.prompt_tokens_details)}`);
          }
          if (usage.completion_tokens_details) {
            console.log(`           completion_details: ${JSON.stringify(usage.completion_tokens_details)}`);
          }
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.error(`\n❌ Timeout after ${TIMEOUT_MS / 1000}s`);
    } else {
      console.error(`\n💥 Stream error: ${e.message}`);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const totalMs = tLastChunk || (performance.now() - t0);

  console.log(`\n\n┌─ Results ──────────────────────────────────────`);
  console.log(`│ Model:           ${MODEL}`);
  console.log(`│ Total time:      ${totalMs.toFixed(0)}ms (${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`│ TTFB:            ${ttfb?.toFixed(0) ?? "n/a"}ms`);
  console.log(`│ TTFT:            ${ttft?.toFixed(0) ?? "n/a"}ms`);
  console.log(`│ First content:   ${ttFirstContent?.toFixed(0) ?? "n/a"}ms`);
  console.log(`│ First chunk type: ${firstChunkType ?? "n/a"}`);
  console.log(`│ Chunks:          ${totalChunks} total, ${contentChunks} content, ${reasoningChunks} reasoning, ${usageChunks} usage, ${doneChunks} [DONE]`);
  console.log(`│ SSE comments:    ${comments.length}`);
  console.log(`│ Content:         "${fullContent.slice(0, 200)}${fullContent.length > 200 ? "…" : ""}"`);
  if (fullReasoning) {
    console.log(`│ Reasoning:       ${fullReasoning.length} chars`);
  }
  if (usage) {
    console.log(`│ Tokens:          prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
  }
  console.log(`└────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
