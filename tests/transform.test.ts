import { describe, expect, it } from "vitest";
import { imageEvictionCount, transformContextForImageLimit } from "../transform";

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

describe("imageEvictionCount slide schedule", () => {
  it("returns 0 at or under the cap", () => {
    expect(imageEvictionCount(0, 20)).toBe(0);
    expect(imageEvictionCount(20, 20)).toBe(0);
  });

  it("drops everything for a zero cap", () => {
    expect(imageEvictionCount(7, 0)).toBe(7);
  });

  it("defaults to quarter-cap chunks (H=5 at cap 20)", () => {
    // Slides at counts 21, 26, 31, 36, 41, ...
    expect(imageEvictionCount(21, 20)).toBe(5);
    expect(imageEvictionCount(25, 20)).toBe(5);
    expect(imageEvictionCount(26, 20)).toBe(10);
    expect(imageEvictionCount(40, 20)).toBe(20);
    expect(imageEvictionCount(41, 20)).toBe(25);
  });

  it("small caps default to H=2", () => {
    expect(imageEvictionCount(5, 4)).toBe(2);
    expect(imageEvictionCount(6, 4)).toBe(2);
    expect(imageEvictionCount(7, 4)).toBe(4);
  });

  it("treats H=1 as exact FIFO", () => {
    for (const count of [21, 22, 30]) {
      expect(imageEvictionCount(count, 20, 1)).toBe(count - 20);
    }
  });

  it("honors an explicit override", () => {
    // H=3 at cap 10: slides at 11, 14, 17, ...
    expect(imageEvictionCount(11, 10, 3)).toBe(3);
    expect(imageEvictionCount(13, 10, 3)).toBe(3);
    expect(imageEvictionCount(14, 10, 3)).toBe(6);
    expect(imageEvictionCount(16, 10, 3)).toBe(6);
    expect(imageEvictionCount(17, 10, 3)).toBe(9);
  });

  it("clamps the override so at least one image survives", () => {
    expect(imageEvictionCount(4, 3, 99)).toBe(2);
    expect(imageEvictionCount(4, 3, 99)).toBeLessThan(4);
  });
});

describe("transformContextForImageLimit hysteresis", () => {
  function imgs(n: number, start = 1) {
    return Array.from({ length: n }, (_, i) => img(start + i));
  }
  function keptIds(out: any): string[] {
    return out.messages.flatMap((m: any) =>
      (m.content as any[]).filter((b) => b.type === "image").map((b) => b.data),
    );
  }

  it("evicts a full chunk at the first crossing (21 imgs, cap 20 → keeps newest 16)", () => {
    const c = { messages: [{ role: "user", content: [txt("shots"), ...imgs(21)] }] };
    const out = transformContextForImageLimit(c, 20);
    expect(keptIds(out)).toEqual(imgs(16, 6).map((b) => b.data));
    // Text survives.
    expect(out.messages[0].content[0]).toEqual(txt("shots"));
  });

  it("keeps the payload prefix-stable between slide events", () => {
    const first = { role: "user", content: imgs(21) };
    const out21 = transformContextForImageLimit({ messages: [first] }, 20);
    // Next turn: one image appended — eviction must NOT fire again.
    const out22 = transformContextForImageLimit(
      { messages: [first, { role: "user", content: [img(22)] }] },
      20,
    );
    const prev = keptIds(out21);
    const next = keptIds(out22);
    expect(next.slice(0, prev.length)).toEqual(prev);
    expect(next).toHaveLength(prev.length + 1);
  });

  it("slides by another chunk at the next boundary (26 imgs → keeps newest 16)", () => {
    const c = { messages: [{ role: "user", content: imgs(26) }] };
    const out = transformContextForImageLimit(c, 20);
    expect(keptIds(out)).toEqual(imgs(16, 11).map((b) => b.data));
  });

  it("honors an explicit per-model hysteresis override", () => {
    const out11 = transformContextForImageLimit({ messages: [{ role: "user", content: imgs(11) }] }, 10, 3);
    expect(keptIds(out11)).toEqual(imgs(8, 4).map((b) => b.data));
    const out14 = transformContextForImageLimit({ messages: [{ role: "user", content: imgs(14) }] }, 10, 3);
    expect(keptIds(out14)).toEqual(imgs(8, 7).map((b) => b.data));
  });

  it("H=1 reproduces exact per-turn FIFO", () => {
    const out = transformContextForImageLimit({ messages: [{ role: "user", content: imgs(22) }] }, 20, 1);
    expect(keptIds(out)).toEqual(imgs(20, 3).map((b) => b.data));
  });

  it("inserts placeholders for image-only messages caught in a batch", () => {
    const c = {
      messages: [
        { role: "user", content: [img(1)] },
        { role: "user", content: [img(2)] },
        { role: "user", content: [img(3)] },
        { role: "user", content: [img(4)] },
      ],
    };
    const out = transformContextForImageLimit(c, 3, 2);
    expect(out.messages).toEqual([
      { role: "user", content: [txt("[image removed]")] },
      { role: "user", content: [txt("[image removed]")] },
      { role: "user", content: [img(3)] },
      { role: "user", content: [img(4)] },
    ]);
  });
});
