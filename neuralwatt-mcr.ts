import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumePendingMCR, makeProviderConfig } from "./index";
import chadFactory from "./chad-mcr-upstream";

// Thin wrapper that delegates to Chad's upstream @neuralwatt/pi-mcr-extension
// with two runtime patches:
//
//   1. Proxy pi: registerProvider("neuralwatt", ...) stripped of
//      baseUrl/api/models, env-var values $-prefixed. Then we re-register
//      our full provider (streamSimple + SWR models + headers) to guarantee
//      it wins regardless of whether Chad's npm package is also installed.
//
//   2. turn_end handler: SSE bridge (consumePendingMCR) feeds energy/MCR
//      data from index.ts's HTTP tee. Chad reads from after_provider_response
//      headers and message_end body — neither carries SSE comment data.
//
// chad-mcr-upstream.ts is fetched from Chad's repo and committed. Update it
// with: npm run sync-mcr
//
// No npm package coupling needed — Chad's file is a local static import,
// resolved by Pi's jiti just like any multi-file extension.

// Sentinel on globalThis to detect when Chad's MCR extension has already been
// loaded directly by Pi (e.g. someone ran `pi install npm:@neuralwatt/pi-mcr-extension`
// alongside our package). If the sentinel is set, Chad's handlers already registered
// and his registerProvider already fired — our wrapper skips the duplicate factory
// invocation but still registers the turn_end bridge handler.
const MCR_LOADED_SENTINEL = Symbol.for("pi-neuralwatt-provider.mcr-loaded");

function isMCRModel(modelId: string): boolean {
  return modelId.includes("neuralwatt/") || modelId.endsWith("-long") || modelId.endsWith("-mcr");
}

export default function (pi: ExtensionAPI) {
  const chadAlreadyLoaded = !!(globalThis as any)[MCR_LOADED_SENTINEL];
  (globalThis as any)[MCR_LOADED_SENTINEL] = true;
  // ── Proxy pi: intercept registerProvider ────────────────────────────────
  //
  // Chad's registerProvider("neuralwatt", { baseUrl, api, models, apiKey,
  // headers }) would REPLACE the provider that index.ts registered (with
  // streamSimple, energy tee, quota widget). We intercept and strip the
  // fields that would clobber the provider identity, keeping only apiKey
  // and headers (for outbound X-NW-* HTTP headers).
  //
  // Also $-prefix the env-var values: Pi deprecated bare-name resolution
  // ("NEURALWATT_API_KEY" → warns, future removal). Chad uses bare names
  // because his package targets a standalone install where he owns the full
  // provider registration.
  const proxy: ExtensionAPI = Object.create(pi);
  proxy.registerProvider = (name: string, config: any) => {
    if (name === "neuralwatt") {
      const { apiKey, headers } = config;
      const patchedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers || {})) {
        patchedHeaders[k] =
          typeof v === "string" && !v.startsWith("$")
            ? `$${v}`
            : (v as string);
      }
      pi.registerProvider(name, {
        apiKey:
          typeof apiKey === "string" && !apiKey.startsWith("$")
            ? `$${apiKey}`
            : apiKey,
        headers: patchedHeaders,
      });
    } else {
      pi.registerProvider(name, config);
    }
  };

  // ── Invoke Chad's factory with the proxy (skip if already loaded) ──────
  //
  // If Chad's extension was loaded directly by Pi (npm package installed
  // alongside ours), his handlers and registerProvider already fired. Invoking
  // his factory again would duplicate every handler and context-drop would
  // operate on already-dropped indices.
  //
  // When we skip, Chad's full registerProvider stands — but we re-register
  // our provider below to ensure streamSimple wins.
  if (!chadAlreadyLoaded) {
    chadFactory(proxy);
  }

  // ── Re-register our provider after all load-time writes ──────────────────
  //
  // If Chad's npm package is installed directly, its registerProvider with
  // api: "openai-completions" + models already replaced ours. The proxy
  // prevents this when Chad loads through our wrapper, but can't intercept
  // a direct load. Re-registering here (after all extensions have loaded)
  // guarantees our streamSimple + SWR models are the final provider entry.
  // Idempotent when Chad isn't installed.
  pi.registerProvider("neuralwatt", makeProviderConfig());

  // ── Bridge state (reset on session_start to stay aligned with Chad) ────
  const MCR_STATUS_KEY = "nw-mcr";
  const ENERGY_STATUS_KEY = "nw-energy";

  let bridgeSessionFp: string | null = null;
  let bridgeSafeDropBefore = 0;
  let bridgeTotalEnergyJoules = 0;

  pi.on("session_start", async () => {
    bridgeSessionFp = null;
    bridgeSafeDropBefore = 0;
    bridgeTotalEnergyJoules = 0;
  });

  // ── turn_end SSE bridge handler ────────────────────────────────────────
  //
  // Event ordering: before_provider_request → [stream] → message_update →
  // message_end → turn_end. Chad's handlers write to nw-mcr/nw-energy during
  // after_provider_response and message_end. Our turn_end fires after those,
  // so when both have data, the bridge overwrites Chad's write. This is
  // correct: SSE comment data and parsed response body come from the same
  // server response, but SSE comments carry data (energy joules, mcr session)
  // that the parsed response body doesn't always include.
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const modelId = ctx.model?.id || "";
    if (!isMCRModel(modelId)) return;

    const { energyRaw, mcrSessionRaw } = consumePendingMCR();

    if (mcrSessionRaw && typeof mcrSessionRaw.session_fp === "string") {
      bridgeSessionFp = mcrSessionRaw.session_fp as string;
      bridgeSafeDropBefore =
        typeof mcrSessionRaw.safe_drop_before === "number"
          ? (mcrSessionRaw.safe_drop_before as number)
          : 0;

      const parts = [`MCR ${bridgeSessionFp.slice(0, 8)}`];
      if (bridgeSafeDropBefore > 0) {
        parts.push(`drop<${bridgeSafeDropBefore}`);
      }
      ctx.ui.setStatus(MCR_STATUS_KEY, parts.join(" | "));
    }

    if (energyRaw && typeof energyRaw.energy_joules === "number") {
      bridgeTotalEnergyJoules += energyRaw.energy_joules as number;

      const j = bridgeTotalEnergyJoules;
      const energyText =
        j < 1 ? `${(j * 1000).toFixed(0)}mJ` :
        j < 1000 ? `${j.toFixed(1)}J` :
        `${(j / 1000).toFixed(2)}kJ`;

      const parts: string[] = [`⚡ ${energyText}`];
      const mcr = energyRaw.mcr as Record<string, unknown> | undefined;
      if (mcr && typeof mcr === "object") {
        if (typeof mcr.apc_hit_rate === "number") {
          parts.push(`APC ${((mcr.apc_hit_rate as number) * 100).toFixed(0)}%`);
        }
        if (
          typeof mcr.mcr_compacted_tokens === "number" &&
          typeof mcr.mcr_original_tokens === "number"
        ) {
          const ratio =
            (mcr.mcr_compacted_tokens as number) /
            (mcr.mcr_original_tokens as number);
          parts.push(`compact ${(ratio * 100).toFixed(0)}%`);
        }
      }
      ctx.ui.setStatus(ENERGY_STATUS_KEY, parts.join(" | "));
    }
  });
}
