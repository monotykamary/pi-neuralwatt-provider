import { describe, expect, it } from "vitest";
import { appendErrorCodeToMessage } from "../index.js";

// Real error bodies captured from the Neuralwatt serving layer (2026-06-04).
// Same model (zai-org/GLM-5.1-FP8), same code, two different message wordings
// depending on whether the prompt exceeded the hard context limit or only
// safe_max_prompt_tokens after server-side compaction.
const HARD_OVERFLOW_BODY = JSON.stringify({
  error: {
    message:
      "This model's maximum context length is 200000 tokens. Your request requires at least 205541 tokens (205541 prompt + 0 max_tokens). Please reduce your input or max_tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
    param: null,
    prompt_tokens: 205541,
    context_limit: 200000,
    safe_max_prompt_tokens: 200000,
  },
});

const SOFT_OVERFLOW_BODY = JSON.stringify({
  error: {
    message:
      "Your conversation is too long for this model's context window even after compaction. Reduce the conversation length or enable/allow compaction.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
    param: null,
    prompt_tokens: 196852,
    context_limit: 200000,
    safe_max_prompt_tokens: 195904,
  },
});

describe("appendErrorCodeToMessage", () => {
  it("appends the code to the soft-overflow wording Pi cannot classify", () => {
    const out = JSON.parse(appendErrorCodeToMessage(SOFT_OVERFLOW_BODY));
    expect(out.error.message).toBe(
      "Your conversation is too long for this model's context window even after compaction. Reduce the conversation length or enable/allow compaction. (context_length_exceeded)",
    );
    // Pi-ai's generic overflow fallback must now match the message alone.
    expect(/context[_ ]length[_ ]exceeded/i.test(out.error.message)).toBe(true);
  });

  it("appends the code to the hard-overflow wording too", () => {
    const out = JSON.parse(appendErrorCodeToMessage(HARD_OVERFLOW_BODY));
    expect(out.error.message).toMatch(/\(context_length_exceeded\)$/);
  });

  it("preserves all other fields of the error body", () => {
    const out = JSON.parse(appendErrorCodeToMessage(SOFT_OVERFLOW_BODY));
    expect(out.error.type).toBe("invalid_request_error");
    expect(out.error.prompt_tokens).toBe(196852);
    expect(out.error.context_limit).toBe(200000);
    expect(out.error.safe_max_prompt_tokens).toBe(195904);
  });

  it("leaves the body unchanged when the message already contains the code", () => {
    const body = JSON.stringify({
      error: { message: "failed: context_length_exceeded", code: "context_length_exceeded" },
    });
    expect(appendErrorCodeToMessage(body)).toBe(body);
  });

  it("leaves non-JSON bodies unchanged", () => {
    expect(appendErrorCodeToMessage("502 Bad Gateway")).toBe("502 Bad Gateway");
    expect(appendErrorCodeToMessage("")).toBe("");
  });

  it("leaves JSON without an error code unchanged", () => {
    const body = JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error", code: null } });
    expect(appendErrorCodeToMessage(body)).toBe(body);
  });

  it("leaves non-error JSON unchanged", () => {
    const body = JSON.stringify({ id: "chatcmpl-1", choices: [] });
    expect(appendErrorCodeToMessage(body)).toBe(body);
  });
});
