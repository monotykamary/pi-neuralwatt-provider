import { describe, expect, it } from "vitest";

// Inline the function so the test doesn't depend on side-effectful module loading
function transformContextForImageLimit(context: any, maxImages: number | undefined) {
  if (maxImages === undefined || maxImages === null || !Array.isArray(context?.messages)) return context;

  type ImageRef = { msgIndex: number; blockIndex: number };
  const images: ImageRef[] = [];

  for (let m = 0; m < context.messages.length; m++) {
    const msg = context.messages[m];
    if (!msg?.content) continue;
    const content = msg.content;
    if (typeof content === "string") continue;
    for (let c = 0; c < content.length; c++) {
      if (content[c]?.type === "image") images.push({ msgIndex: m, blockIndex: c });
    }
  }

  if (images.length <= maxImages) return context;

  const toRemove = images.length - maxImages;
  const removedIndices = new Set<string>();
  for (let i = 0; i < toRemove; i++) {
    removedIndices.add(`${images[i].msgIndex},${images[i].blockIndex}`);
  }

  const newMessages = context.messages.map((msg: any, msgIndex: number) => {
    if (!msg?.content) return msg;
    const content = msg.content;
    if (typeof content === "string") return msg;

    const newContent = content.filter((_block: any, blockIndex: number) => {
      return !removedIndices.has(`${msgIndex},${blockIndex}`);
    });

    if (newContent.length === content.length) return msg;

    const hadImages = content.some((block: any) => block?.type === "image");
    if (hadImages && newContent.length === 0) {
      newContent.push({ type: "text", text: "[image removed]" });
    }

    return { ...msg, content: newContent };
  });

  return { ...context, messages: newMessages };
}

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
