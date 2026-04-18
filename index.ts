/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (api.neuralwatt.com) as a custom provider with energy-aware streaming.
 * Base URL: https://api.neuralwatt.com/v1
 *
 * Neuralwatt returns energy consumption data (kWh, Joules) and request cost with every
 * API response. This extension captures that data via a custom stream handler that parses
 * SSE comments (the OpenAI SDK discards them), then displays it in the pi footer.
 *
 * Usage:
 *   # Set your API key
 *   export NEURALWATT_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-neuralwatt-provider
 *
 * Then use /model to select from available models like Kimi K2.5, GLM 5, GLM 5.1,
 * Qwen3.5, GPT-OSS 20B, Devstral Small 2, and MiniMax M2.5.
 *
 * Neuralwatt Features:
 *   - OpenAI-compatible API (https://api.neuralwatt.com/v1)
 *   - Reasoning/thinking models
 *   - Vision models (Kimi K2.5)
 *   - Tool use support
 *   - Streaming support
 *   - Energy reporting per-request (Joules, kWh, watts, duration)
 *   - Request cost reporting (USD)
 *
 * @see https://neuralwatt.com
 */

import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getEnvApiKey,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import type { AssistantMessage as PiAiAssistantMessage, AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import models from "./models.json" with { type: "json" };

// ─── Inline: sanitize Unicode surrogates ──────────────────────────────────────
// Not exported from @mariozechner/pi-ai main index, so we inline the one-liner.

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ─── Session State (event-sourced via pi.appendEntry) ─────────────────────────

/**
 * Per-request energy/cost event, persisted as a custom entry in the session.
 * On restore, we replay all entries in the current branch to rebuild totals.
 * This naturally handles branching, forking, and tree navigation.
 */
interface EnergyEvent {
  energy_joules: number;
  cost_usd: number;
}

const ENERGY_ENTRY_TYPE = "neuralwatt-energy";

/** In-memory totals for the current branch (rebuilt on session_start / tree nav) */
let sessionEnergyJoules = 0;
let sessionCostUsd = 0;

/** Pending per-request metrics — accumulated during streaming, persisted on turn_end */
let pendingEnergyJoules = 0;
let pendingCostUsd = 0;

function resetSessionState() {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  pendingEnergyJoules = 0;
  pendingCostUsd = 0;
}

/**
 * Replay all energy events from the session branch to rebuild totals.
 */
function replayEnergyEvents(ctx: any): void {
  sessionEnergyJoules = 0;
  sessionCostUsd = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENERGY_ENTRY_TYPE && entry.data) {
      sessionEnergyJoules += entry.data.energy_joules || 0;
      sessionCostUsd += entry.data.cost_usd || 0;
    }
  }
}

/**
 * Build the status text for the neuralwatt energy/cost indicator.
 */
function buildEnergyStatusText(): string | undefined {
  if (sessionEnergyJoules <= 0 && sessionCostUsd <= 0) return undefined;
  const energyStr = formatEnergy(sessionEnergyJoules);
  const costStr = formatCost(sessionCostUsd);
  return `⚡${energyStr} ${costStr}`;
}

/**
 * Update the footer status indicator with current energy/cost totals.
 * Uses theme.fg("dim", ...) for grey text.
 */
function updateEnergyStatus(ctx: any): void {
  const text = buildEnergyStatusText();
  ctx.ui.setStatus("neuralwatt", text ? ctx.ui.theme.fg("dim", text) : undefined);
}

// ─── Model Configuration ─────────────────────────────────────────────────────

interface NeuralwattModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  };
}

const piModels = (models as NeuralwattModel[]).map((model) => {
  const result: any = {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  if (model.compat) {
    result.compat = model.compat;
  }
  return result;
});

// ─── Energy Formatting ────────────────────────────────────────────────────────

/**
 * Format energy in Joules to the most readable unit.
 * Uses: J → mWh → Wh → kWh with appropriate precision.
 */
function formatEnergy(joules: number): string {
  if (joules === 0) return "0J";
  // 1 Wh = 3600 J, 1 mWh = 3.6 J, 1 kWh = 3,600,000 J
  if (joules < 3.6) {
    return joules < 10 ? `${joules.toFixed(1)}J` : `${Math.round(joules)}J`;
  }
  const mwh = joules / 3600;
  if (mwh < 1000) {
    return mwh < 10 ? `${mwh.toFixed(1)}mWh` : `${Math.round(mwh)}mWh`;
  }
  const wh = mwh / 1000;
  if (wh < 1000) {
    return wh < 10 ? `${wh.toFixed(1)}Wh` : `${Math.round(wh)}Wh`;
  }
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)}kWh`;
}

/**
 * Format cost in USD. Shows appropriate precision for small amounts.
 */
function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (usd < 1) return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

const BASE_URL = "https://api.neuralwatt.com/v1";

/**
 * Neuralwatt's custom stream handler.
 *
 * Neuralwatt returns energy and cost data that the OpenAI SDK discards:
 * - Non-streaming: top-level `energy` and `cost` JSON fields
 * - Streaming: SSE comment lines `: energy {...}` and `: cost {...}`
 *
 * This handler uses raw fetch + manual SSE parsing to capture everything.
 * The OpenAI-completions parsing logic (chunks, choices, usage, thinking, tool_calls)
 * is based on pi-ai's built-in openai-completions.ts provider.
 */
function streamNeuralwatt(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
    if (!apiKey) {
      throw new Error(`No API key for provider: ${model.provider}`);
    }

    const output: PiAiAssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Build request payload
      const params = buildNeuralwattParams(model, context, options);

      // Make raw fetch request (not OpenAI SDK) so we can parse SSE comments
      const url = `${model.baseUrl || BASE_URL}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(model.headers || {}),
          ...(options?.headers || {}),
        },
        body: JSON.stringify(params),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Neuralwatt API error ${response.status}: ${errorText}`);
      }

      stream.push({ type: "start", partial: output });

      if (params.stream) {
        // ── Streaming: parse SSE with comment support ──────────────────────
        await parseStreamingResponse(response, output, stream, model);
      } else {
        // ── Non-streaming: parse JSON response ─────────────────────────────
        const json = await response.json();
        parseNonStreamingResponse(json, output, model);
      }

      // Finish current block
      finishCurrentBlock(output, stream, null);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as any).index;
        delete (block as any).partialArgs;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ─── Request Building ─────────────────────────────────────────────────────────

function buildNeuralwattParams(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  const compat = getCompat(model);
  const messages = convertMessages(model, context, compat);

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
  };

  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  // Tool support
  if (context.tools && context.tools.length > 0) {
    params.tools = context.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      },
    }));
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  // Thinking/reasoning support
  if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = !!options?.reasoning;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: !!options?.reasoning,
      preserve_thinking: true,
    };
  } else if (options?.reasoning && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = options.reasoning;
  }

  return params;
}

// ─── Streaming SSE Parser ─────────────────────────────────────────────────────

interface CurrentBlock {
  type: "text" | "thinking" | "toolCall";
}

async function parseStreamingResponse(
  response: Response,
  output: PiAiAssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<string>,
): Promise<void> {
  let currentBlockType: CurrentBlock["type"] | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();

      // ── SSE comment: energy data ────────────────────────────────────────
      if (trimmed.startsWith(": energy ")) {
        try {
          const energy = JSON.parse(trimmed.slice(9));
          pendingEnergyJoules += energy.energy_joules || 0;
        } catch {
          // Malformed energy comment, ignore
        }
        continue;
      }

      // ── SSE comment: cost data ──────────────────────────────────────────
      if (trimmed.startsWith(": cost ")) {
        try {
          const cost = JSON.parse(trimmed.slice(7));
          pendingCostUsd += cost.request_cost_usd || 0;
        } catch {
          // Malformed cost comment, ignore
        }
        continue;
      }

      // ── SSE comment (other) — ignore ────────────────────────────────────
      if (trimmed.startsWith(":")) {
        continue;
      }

      // ── SSE data event ──────────────────────────────────────────────────
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      if (!chunk || typeof chunk !== "object") continue;

      // Capture response ID
      output.responseId ||= chunk.id;

      // Usage (sometimes arrives in a chunk with empty choices)
      if (chunk.usage) {
        output.usage = parseChunkUsage(chunk.usage, model);
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) continue;

      // Fallback usage in choice (Moonshot-style)
      if (!chunk.usage && choice.usage) {
        output.usage = parseChunkUsage(choice.usage, model);
      }

      // Finish reason
      if (choice.finish_reason) {
        const result = mapStopReason(choice.finish_reason);
        output.stopReason = result.stopReason;
        if (result.errorMessage) output.errorMessage = result.errorMessage;
      }

      if (!choice.delta) continue;

      // ── Text content ────────────────────────────────────────────────────
      if (choice.delta.content != null && choice.delta.content.length > 0) {
        if (currentBlockType !== "text") {
          finishCurrentBlock(output, stream, currentBlockType);
          currentBlockType = "text";
          blocks.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
        const block = blocks[blocks.length - 1];
        if (block.type === "text") {
          block.text += choice.delta.content;
          stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: choice.delta.content, partial: output });
        }
      }

      // ── Thinking/reasoning content ───────────────────────────────────────
      const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
      let foundReasoningField: string | null = null;
      for (const field of reasoningFields) {
        if (choice.delta[field] != null && choice.delta[field].length > 0) {
          foundReasoningField = field;
          break;
        }
      }
      if (foundReasoningField) {
        if (currentBlockType !== "thinking") {
          finishCurrentBlock(output, stream, currentBlockType);
          currentBlockType = "thinking";
          blocks.push({ type: "thinking", thinking: "", thinkingSignature: foundReasoningField });
          stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
        }
        const block = blocks[blocks.length - 1];
        if (block.type === "thinking") {
          const delta = choice.delta[foundReasoningField];
          block.thinking += delta;
          stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta, partial: output });
        }
      }

      // ── Tool calls ──────────────────────────────────────────────────────
      if (choice.delta?.tool_calls) {
        for (const toolCall of choice.delta.tool_calls) {
          const lastBlock = blocks[blocks.length - 1];
          const isNewToolCall = currentBlockType !== "toolCall" || (toolCall.id && lastBlock?.type === "toolCall" && (lastBlock as any).id !== toolCall.id);

          if (isNewToolCall) {
            finishCurrentBlock(output, stream, currentBlockType);
            currentBlockType = "toolCall";
            blocks.push({
              type: "toolCall",
              id: toolCall.id || "",
              name: toolCall.function?.name || "",
              arguments: {},
              partialArgs: "",
            });
            stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          }
          const block = blocks[blocks.length - 1];
          if (block.type === "toolCall") {
            if (toolCall.id) block.id = toolCall.id;
            if (toolCall.function?.name) block.name = toolCall.function.name;
            let delta = "";
            if (toolCall.function?.arguments) {
              delta = toolCall.function.arguments;
              (block as any).partialArgs += toolCall.function.arguments;
              block.arguments = parseStreamingJson((block as any).partialArgs);
            }
            stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
          }
        }
      }

      // ── Reasoning details (encrypted thinking signatures) ───────────────
      const reasoningDetails = choice.delta.reasoning_details;
      if (reasoningDetails && Array.isArray(reasoningDetails)) {
        for (const detail of reasoningDetails) {
          if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
            const matchingBlock = blocks.find((b: any) => b.type === "toolCall" && b.id === detail.id);
            if (matchingBlock && matchingBlock.type === "toolCall") {
              matchingBlock.thoughtSignature = JSON.stringify(detail);
            }
          }
        }
      }
    }
  }
}

// ─── Non-Streaming Response Parser ────────────────────────────────────────────

function parseNonStreamingResponse(json: any, output: PiAiAssistantMessage, model: Model<string>): void {
  // Extract energy data from top-level field
  if (json.energy) {
    pendingEnergyJoules += json.energy.energy_joules || 0;
  }

  // Note: Neuralwatt non-streaming doesn't currently return a `cost` top-level
  // field, but handle it if it appears in the future
  if (json.cost) {
    pendingCostUsd += json.cost.request_cost_usd || 0;
  }

  // Standard OpenAI response parsing
  output.responseId = json.id;
  output.model = json.model || output.model;

  if (json.usage) {
    const usage = parseChunkUsage(json.usage, model);
    output.usage = usage;
  }

  const choice = json.choices?.[0];
  if (!choice) return;

  output.stopReason = mapStopReason(choice.finish_reason).stopReason;

  const message = choice.message;
  if (!message) return;

  // Text content
  if (message.content) {
    output.content.push({ type: "text", text: message.content });
  }

  // Reasoning/thinking
  const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
  for (const field of reasoningFields) {
    if (message[field]) {
      output.content.push({ type: "thinking", thinking: message[field], thinkingSignature: field });
      break;
    }
  }

  // Tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      output.content.push({
        type: "toolCall",
        id: tc.id || "",
        name: tc.function?.name || "",
        arguments: typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || {},
      });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Finish the current streaming block (text, thinking, or toolCall).
 */
function finishCurrentBlock(
  output: PiAiAssistantMessage,
  stream: AssistantMessageEventStream,
  blockType: CurrentBlock["type"] | null,
): void {
  if (!blockType) return;
  const blocks = output.content;
  const idx = blocks.length - 1;
  if (idx < 0) return;
  const b = blocks[idx];
  if (!b) return;

  if (blockType === "text" && b.type === "text") {
    stream.push({ type: "text_end", contentIndex: idx, content: b.text, partial: output });
  } else if (blockType === "thinking" && b.type === "thinking") {
    stream.push({ type: "thinking_end", contentIndex: idx, content: b.thinking, partial: output });
  } else if (blockType === "toolCall" && b.type === "toolCall") {
    b.arguments = parseStreamingJson((b as any).partialArgs);
    delete (b as any).partialArgs;
    stream.push({
      type: "toolcall_end",
      contentIndex: idx,
      toolCall: { type: "toolCall" as const, id: b.id, name: b.name, arguments: b.arguments },
      partial: output,
    });
  }
}

/**
 * Parse usage from a streaming chunk and calculate cost using the model's pricing.
 */
function parseChunkUsage(
  rawUsage: any,
  model: Model<string>,
): PiAiAssistantMessage["usage"] {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens || 0;

  const cacheReadTokens = cacheWriteTokens > 0
    ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
    : reportedCachedTokens;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = (rawUsage.completion_tokens || 0) + reasoningTokens;

  const usage: PiAiAssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  calculateCost(model, usage);
  return usage;
}

function mapStopReason(reason: string | null): { stopReason: PiAiAssistantMessage["stopReason"]; errorMessage?: string } {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}

// ─── Compat Detection ─────────────────────────────────────────────────────────

interface NeuralwattCompat {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  supportsUsageInStreaming: boolean;
  maxTokensField: "max_completion_tokens" | "max_tokens";
  thinkingFormat: string;
}

function getCompat(model: Model<string>): NeuralwattCompat {
  const compat = (model as any).compat;
  return {
    supportsDeveloperRole: compat?.supportsDeveloperRole ?? false,
    supportsReasoningEffort: compat?.supportsReasoningEffort ?? false,
    supportsUsageInStreaming: compat?.supportsUsageInStreaming ?? true,
    maxTokensField: compat?.maxTokensField ?? "max_completion_tokens",
    thinkingFormat: compat?.thinkingFormat ?? "qwen",
  };
}

// ─── Message Conversion ──────────────────────────────────────────────────────

function convertMessages(model: Model<string>, context: Context, compat: NeuralwattCompat): any[] {
  const params: any[] = [];

  // System prompt
  if (context.systemPrompt) {
    const role = compat.supportsDeveloperRole ? "developer" : "system";
    params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
      } else if (Array.isArray(msg.content)) {
        const content = msg.content.map((item: any) => {
          if (item.type === "text") {
            return { type: "text", text: sanitizeSurrogates(item.text) };
          } else if (item.type === "image") {
            return { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } };
          }
          return item;
        });
        const filteredContent = !model.input.includes("image")
          ? content.filter((c: any) => c.type !== "image_url")
          : content;
        if (filteredContent.length > 0) {
          params.push({ role: "user", content: filteredContent });
        }
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: any = { role: "assistant", content: null };

      const textBlocks = msg.content.filter((b: any) => b.type === "text");
      const nonEmptyTextBlocks = textBlocks.filter((b: any) => b.text && b.text.trim().length > 0);
      if (nonEmptyTextBlocks.length > 0) {
        assistantMsg.content = nonEmptyTextBlocks.map((b: any) => sanitizeSurrogates(b.text)).join("");
      }

      // Thinking blocks
      const thinkingBlocks = msg.content.filter((b: any) => b.type === "thinking");
      const nonEmptyThinkingBlocks = thinkingBlocks.filter((b: any) => b.thinking && b.thinking.trim().length > 0);
      if (nonEmptyThinkingBlocks.length > 0) {
        const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
        if (signature && signature.length > 0) {
          assistantMsg[signature] = nonEmptyThinkingBlocks.map((b: any) => b.thinking).join("\n");
        }
      }

      // Tool calls
      const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      const hasContent = assistantMsg.content !== null && assistantMsg.content !== undefined &&
        (typeof assistantMsg.content === "string" ? assistantMsg.content.length > 0 : (Array.isArray(assistantMsg.content) ? assistantMsg.content.length > 0 : false));
      if (!hasContent && !assistantMsg.tool_calls) continue;

      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const toolMsg = msg as any;
      const textResult = toolMsg.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("\n") || "";
      params.push({
        role: "tool",
        content: sanitizeSurrogates(textResult || "(no text)"),
        tool_call_id: toolMsg.toolCallId,
      });
    }
  }

  return params;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register provider with custom stream handler
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "NEURALWATT_API_KEY",
    api: "neuralwatt",
    models: piModels,
    streamSimple: streamNeuralwatt,
  });

  // After each turn: persist pending energy event, update status
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingEnergyJoules > 0 || pendingCostUsd > 0) {
      pi.appendEntry(ENERGY_ENTRY_TYPE, {
        energy_joules: pendingEnergyJoules,
        cost_usd: pendingCostUsd,
      } as EnergyEvent);
      sessionEnergyJoules += pendingEnergyJoules;
      sessionCostUsd += pendingCostUsd;
      pendingEnergyJoules = 0;
      pendingCostUsd = 0;
    }
    updateEnergyStatus(ctx);
  });

  // On session start/resume: replay energy events from session entries
  pi.on("session_start", async (_event, ctx) => {
    resetSessionState();
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });

  // On tree navigation: replay energy events for the new branch
  pi.on("session_tree", async (_event, ctx) => {
    replayEnergyEvents(ctx);
    updateEnergyStatus(ctx);
  });
}
