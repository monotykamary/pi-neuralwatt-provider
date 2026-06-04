import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumePendingMCR, makeProviderConfig } from "./index";
import chadFactory from "./chad-mcr-upstream";

// Thin wrapper that delegates to Chad's upstream @neuralwatt/pi-mcr-extension
// with runtime patches that are purely visual — Chad's functional behavior
// (context-drop, session_fp, headers, conversation-id) runs unmodified.
//
//   1. Proxy pi: registerProvider("neuralwatt", ...) stripped of
//      baseUrl/api/models, env-var values $-prefixed. Then we re-register
//      our full provider (streamSimple + SWR models + headers) to guarantee
//      it wins regardless of whether Chad's npm package is also installed.
//
//   2. Prototype hacking: monkey-patch ctx.ui.setStatus to suppress Chad's
//      nw-mcr/nw-energy status bar writes, since index.ts now handles all
//      display (energy + MCR inline in one widget, quota on the same line).
//      Chad's handlers still run — updateStatusBar, in-flight ticker,
//      context-drop, etc. — we only prevent the duplicate status bar writes.
//
//   3. turn_end SSE bridge drain: consumePendingMCR() empties the globalThis
//      bridge so data doesn't leak between turns. Index.ts already consumed
//      the data for its own display; Chad reads from after_provider_response
//      headers and message_end body (separate path).
//
// chad-mcr-upstream.ts is fetched from Chad's repo and committed. Update it
// with: npm run sync-mcr. Chad's file is byte-identical to upstream.

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

  // ── Prototype hacking: suppress Chad's setStatus writes ──────────────
  //
  // Pi's ExtensionRunner shares one uiContext across all extensions.
  // ctx.ui is a getter that always returns runner.uiContext — the same
  // object that Chad's handlers receive. By monkey-patching setStatus on
  // this shared object in our session_start (which fires before any
  // provider request), we suppress Chad's nw-mcr/nw-energy status bar
  // writes. Index.ts now handles all display (energy + MCR inline in one
  // widget line, quota on the same line). Chad's file stays byte-identical.
  //
  // Safety: the original setStatus is saved and restored on session_shutdown.
  // If runner.setUIContext() swaps the entire uiContext (e.g. during mode
  // change), the re-installation guard in session_start detects the change
  // and re-patches the new object.
  const MCR_STATUS_KEY = "nw-mcr";
  const ENERGY_STATUS_KEY = "nw-energy";
  const INTERCEPTED_KEYS = new Set([MCR_STATUS_KEY, ENERGY_STATUS_KEY]);

  let savedSetStatus: ((key: string, text: string | undefined) => void) | null = null;
  let savedUI: any = null;

  function interceptedSetStatus(key: string, text: string | undefined) {
    if (INTERCEPTED_KEYS.has(key)) {
      // Suppress: index.ts handles all MCR/energy display via its widget.
      // Chad's handlers still run and update internal state (sessionFp,
      // safeDropBefore, context-drop) — we just prevent the status bar
      // writes that would duplicate or conflict with index.ts's display.
      return;
    }
    savedSetStatus!(key, text);
  }

  function installSetStatusIntercept(ui: any) {
    if (savedUI === ui && savedSetStatus !== null) return;
    if (!savedSetStatus || savedUI !== ui) {
      savedSetStatus = ui.setStatus.bind(ui);
    }
    savedUI = ui;
    ui.setStatus = interceptedSetStatus;
  }

  function uninstallSetStatusIntercept() {
    if (savedUI && savedSetStatus) {
      savedUI.setStatus = savedSetStatus;
      savedUI = null;
      savedSetStatus = null;
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    installSetStatusIntercept(ctx.ui);
  });

  pi.on("session_shutdown", async () => {
    uninstallSetStatusIntercept();
  });

  // ── turn_end SSE bridge consumer ──────────────────────────────────────
  //
  // Consume the SSE bridge data so it doesn't leak between turns.
  // The display data is handled by index.ts — we just need to drain
  // the bridge. Chad's context-drop handler uses the data from
  // after_provider_response headers (separate from the SSE bridge).
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const modelId = ctx.model?.id || "";
    if (!isMCRModel(modelId)) return;

    consumePendingMCR();
  });
}
