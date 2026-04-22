#!/usr/bin/env node
/**
 * Quick test for the image-limit transform logic.
 */

function transformContextForImageLimit(context, maxImages) {
  if (maxImages === undefined || maxImages === null || !Array.isArray(context?.messages)) return context;

  const images = [];
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
  const removedIndices = new Set();
  for (let i = 0; i < toRemove; i++) {
    removedIndices.add(`${images[i].msgIndex},${images[i].blockIndex}`);
  }

  const newMessages = context.messages.map((msg, msgIndex) => {
    if (!msg?.content) return msg;
    const content = msg.content;
    if (typeof content === "string") return msg;

    const newContent = content.filter((_block, blockIndex) => {
      return !removedIndices.has(`${msgIndex},${blockIndex}`);
    });

    if (newContent.length === content.length) return msg;

    const hadImages = content.some((block) => block?.type === "image");
    if (hadImages && newContent.length === 0) {
      newContent.push({ type: "text", text: "[image removed]" });
    }

    return { ...msg, content: newContent };
  });

  return { ...context, messages: newMessages };
}

function img(id) { return { type: "image", data: `i${id}`, mimeType: "image/png" }; }
function txt(t)  { return { type: "text", text: t }; }

let pass = 0, fail = 0;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(ok ? `✅ ${name}` : `❌ ${name}`);
  if (!ok) { console.log("   got:", JSON.stringify(got)); console.log("   exp:", JSON.stringify(expected)); fail++; }
  else pass++;
}

// 1. No limit → no change
const c1 = { messages: [{ role: "user", content: [txt("hi"), img(1)] }] };
check("no limit", transformContextForImageLimit(c1, undefined), c1);

// 2. Under limit → no change
const c2 = { messages: [{ role: "user", content: [txt("a"), img(1), img(2)] }] };
check("under limit", transformContextForImageLimit(c2, 5), c2);

// 3. Exactly at limit → no change
const c3 = { messages: [{ role: "user", content: [img(1), img(2), img(3)] }] };
check("exact limit", transformContextForImageLimit(c3, 3), c3);

// 4. Over limit → drop oldest (FIFO). Messages still have text, no placeholder.
const c4 = {
  messages: [
    { role: "user", content: [txt("old"), img(1)] },
    { role: "user", content: [txt("mid"), img(2)] },
    { role: "user", content: [txt("new"), img(3)] },
  ]
};
check("FIFO drop oldest", transformContextForImageLimit(c4, 2), {
  messages: [
    { role: "user", content: [txt("old")] },          // image removed, text kept
    { role: "user", content: [txt("mid"), img(2)] },
    { role: "user", content: [txt("new"), img(3)] },
  ]
});

// 5. Mixed content across messages — drop oldest 2 images (img1, img2), keep latest 3 (img3, img4, img5).
const c5 = {
  messages: [
    { role: "assistant", content: [txt("reply")] },
    { role: "user",      content: [txt("extra"), img(1), img(2), img(3)] },
    { role: "user",      content: [img(4), img(5)] },
  ]
};
check("multi-msg drop", transformContextForImageLimit(c5, 3), {
  messages: [
    { role: "assistant", content: [txt("reply")] },
    { role: "user",      content: [txt("extra"), img(3)] },  // img1, img2 evicted
    { role: "user",      content: [img(4), img(5)] },
  ]
});

// 6. String content untouched
const c6 = {
  messages: [
    { role: "user", content: "just a string" },
    { role: "user", content: [img(1), img(2)] },
  ]
};
check("string content untouched", transformContextForImageLimit(c6, 1), {
  messages: [
    { role: "user", content: "just a string" },
    { role: "user", content: [img(2)] },               // img(1) removed
  ]
});

// 7. ToolResultMessage with images — limit 1 keeps newest, no placeholder since content still non-empty
const c7 = {
  messages: [
    { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [img(1), img(2)], isError: false }
  ]
};
check("toolResult keep newest", transformContextForImageLimit(c7, 1), {
  messages: [
    { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [img(2)], isError: false }
  ]
});

// 8. Images-only message, limit 0 → placeholder (edge case: 0 means all images removed)
const c8 = {
  messages: [
    { role: "user", content: [img(1)] }
  ]
};
check("img-only msg limit 0", transformContextForImageLimit(c8, 0), {
  messages: [
    { role: "user", content: [txt("[image removed]")] }
  ]
});

// 9. Images-only message, limit 1 → keep newest
const c9 = {
  messages: [
    { role: "user", content: [img(1)] },
    { role: "user", content: [img(2)] }
  ]
};
check("img-only msgs keep newest", transformContextForImageLimit(c9, 1), {
  messages: [
    { role: "user", content: [txt("[image removed]")] },  // img(1) evicted
    { role: "user", content: [img(2)] }
  ]
});

// 10. No images at all → pass through
const c10 = {
  messages: [
    { role: "user", content: [txt("hello")] },
    { role: "assistant", content: [txt("hi there")] }
  ]
};
check("no images passthrough", transformContextForImageLimit(c10, 0), c10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
