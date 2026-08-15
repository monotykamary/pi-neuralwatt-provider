/**
 * Vision Image-Limit Transform
 *
 * Count image blocks across all messages in a context and, if over the model's
 * per-request limit, drop the oldest images (FIFO). Keeps text blocks intact.
 * If a message becomes empty after dropping images, a placeholder text is inserted
 * so the API still receives valid content.
 *
 * Eviction is batched (hysteresis) to protect server-side prefix caching. A naive
 * "evict down to the cap" policy re-fires on every request once the session image
 * count stays over the limit (this transform is stateless — it sees the full
 * session each request), and each eviction invalidates the cached prefix at the
 * newly-removed oldest image. Simulated cost: eviction churn accounts for ~94% of
 * prefill tokens in a 1-image/turn session at a 20-image cap.
 *
 * Instead we slide in chunks of H, with the schedule derived purely from the image
 * count so it needs no cross-request state: eviction fires when the count crosses
 * maxImages+1, maxImages+1+H, maxImages+1+2H, ..., dropping H more oldest images
 * each time. Already-evicted images stay evicted, so the payload is byte-identical
 * between slide events (modulo the growing tail) and the server-side cached prefix
 * survives. This buys H image additions per cold prefill instead of paying one per
 * addition; H=1 reproduces exact per-turn FIFO.
 */

/** Hysteresis resolution: explicit override wins, else a quarter of the cap (min 2). */
function resolveHysteresis(maxImages: number, hysteresis?: number): number {
  const raw = hysteresis !== undefined && hysteresis !== null
    ? Math.floor(hysteresis)
    : Math.max(2, Math.ceil(maxImages * 0.25));
  // Keep at least one image when possible; clamping to maxImages-1 guarantees that.
  return Math.max(1, Math.min(raw, maxImages - 1));
}

/**
 * Number of oldest images to evict for a session holding `imageCount` images under
 * a per-request cap of `maxImages`. Returns 0 when at/under the cap. Stateless
 * slide schedule: monotone, and the kept image set only changes at slide events.
 */
export function imageEvictionCount(imageCount: number, maxImages: number, hysteresis?: number): number {
  if (imageCount <= maxImages) return 0;
  if (maxImages <= 0) return imageCount;
  const h = resolveHysteresis(maxImages, hysteresis);
  return (Math.floor((imageCount - maxImages - 1) / h) + 1) * h;
}

export function transformContextForImageLimit(
  context: any,
  maxImages: number | undefined,
  hysteresis?: number,
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

  const toRemove = imageEvictionCount(images.length, maxImages, hysteresis);
  if (toRemove === 0) return context;

  const removedIndices = new Set<string>();
  for (let i = 0; i < Math.min(toRemove, images.length); i++) {
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
