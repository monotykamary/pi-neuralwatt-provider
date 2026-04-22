/**
 * Vision Image-Limit Transform
 *
 * Count image blocks across all messages in a context and, if over the model's
 * per-request limit, drop the oldest images (FIFO).  Keeps text blocks intact.
 * If a message becomes empty after dropping images, a placeholder text is inserted
 * so the API still receives valid content.
 */
export function transformContextForImageLimit(
  context: any,
  maxImages: number | undefined,
): any {
  if (maxImages === undefined || maxImages === null || !Array.isArray(context?.messages)) return context;

  type ImageRef = { msgIndex: number; blockIndex: number };
  const images: ImageRef[] = [];

  for (let m = 0; m < context.messages.length; m++) {
    const msg = context.messages[m];
    if (!msg?.content) continue;
    const content = msg.content;
    if (typeof content === "string") continue;
    for (let c = 0; c < content.length; c++) {
      if (content[c]?.type === "image") {
        images.push({ msgIndex: m, blockIndex: c });
      }
    }
  }

  if (images.length <= maxImages) return context;

  const toRemove = images.length - maxImages;
  const removedIndices = new Set<string>();
  for (let i = 0; i < toRemove; i++) {
    const { msgIndex, blockIndex } = images[i];
    removedIndices.add(`${msgIndex},${blockIndex}`);
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
