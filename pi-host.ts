// Keep host imports in code Pi can map to its own SDK, including in bundled hosts.
export { getAgentDir } from "@earendil-works/pi-coding-agent";
export const loadPiAiCompat = () => import("@earendil-works/pi-ai/compat");
export const loadPiProviders = () => import("@earendil-works/pi-ai/providers/all");
export const loadPiTui = () => import("@earendil-works/pi-tui");
export const loadPiAgent = () => import("@earendil-works/pi-coding-agent");
export const packageRoot = new URL(".", import.meta.url);
