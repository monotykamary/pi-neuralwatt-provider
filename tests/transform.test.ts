import { describe, expect, it } from "vitest";
import { transformContextForImageLimit } from "../transform";

function img(id: number) {
  return { type: "image" as const, data: `i${id}`, mimeType: "image/png" };
}
function txt(t: string) {
  return { type: "text" as const, text: t };
}

describe("transformContextForImageLimit", () => {
  it("passes through when no limit set", () => {
    const c = { messages: [{ role: "user", content: [txt("hi"), img(1)] }] };
    expect(transformContextForImageLimit(c, undefined)).toBe(c);
  });

  it("passes through when under limit", () => {
    const c = { messages: [{ role: "user", content: [txt("a"), img(1), img(2)] }] };
    expect(transformContextForImageLimit(c, 5)).toBe(c);
  });

  it("passes through when exactly at limit", () => {
    const c = { messages: [{ role: "user", content: [img(1), img(2), img(3)] }] };
    expect(transformContextForImageLimit(c, 3)).toBe(c);
  });

  it("drops oldest images first (FIFO)", () => {
    const c = {
      messages: [
        { role: "user", content: [txt("old"), img(1)] },
        { role: "user", content: [txt("mid"), img(2)] },
        { role: "user", content: [txt("new"), img(3)] },
      ],
    };
    const out = transformContextForImageLimit(c, 2);
    expect(out.messages).toEqual([
      { role: "user", content: [txt("old")] },
      { role: "user", content: [txt("mid"), img(2)] },
      { role: "user", content: [txt("new"), img(3)] },
    ]);
  });

  it("handles multi-message drops correctly", () => {
    const c = {
      messages: [
        { role: "assistant", content: [txt("reply")] },
        { role: "user", content: [txt("extra"), img(1), img(2), img(3)] },
        { role: "user", content: [img(4), img(5)] },
      ],
    };
    const out = transformContextForImageLimit(c, 3);
    expect(out.messages).toEqual([
      { role: "assistant", content: [txt("reply")] },
      { role: "user", content: [txt("extra"), img(3)] },
      { role: "user", content: [img(4), img(5)] },
    ]);
  });

  it("preserves string content untouched", () => {
    const c = {
      messages: [
        { role: "user", content: "just a string" },
        { role: "user", content: [img(1), img(2)] },
      ],
    };
    const out = transformContextForImageLimit(c, 1);
    expect(out.messages).toEqual([
      { role: "user", content: "just a string" },
      { role: "user", content: [img(2)] },
    ]);
  });

  it("keeps newest in toolResult messages", () => {
    const c = {
      messages: [
        { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [img(1), img(2)], isError: false },
      ],
    };
    const out = transformContextForImageLimit(c, 1);
    expect(out.messages).toEqual([
      { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [img(2)], isError: false },
    ]);
  });

  it("inserts placeholder when all images are removed from an image-only message", () => {
    const c = { messages: [{ role: "user", content: [img(1)] }] };
    const out = transformContextForImageLimit(c, 0);
    expect(out.messages).toEqual([{ role: "user", content: [txt("[image removed]")] }]);
  });

  it("keeps newest across image-only messages", () => {
    const c = {
      messages: [
        { role: "user", content: [img(1)] },
        { role: "user", content: [img(2)] },
      ],
    };
    const out = transformContextForImageLimit(c, 1);
    expect(out.messages).toEqual([
      { role: "user", content: [txt("[image removed]")] },
      { role: "user", content: [img(2)] },
    ]);
  });

  it("passes through when no images at all", () => {
    const c = {
      messages: [
        { role: "user", content: [txt("hello")] },
        { role: "assistant", content: [txt("hi there")] },
      ],
    };
    expect(transformContextForImageLimit(c, 0)).toBe(c);
  });
});
