# Neuralwatt capabilities in pi

The provider follows the [Neuralwatt changelog](https://portal.neuralwatt.com/changelog) and authenticated [`/v1/models`](https://docs.neuralwatt.com/api/models). The bundled catalog is an offline snapshot; session startup refreshes it with your credentials, including enrolled preview models. Catalog refresh does not enroll you in a preview.

## Clef decision models

Clef Flash is **not a chat model**. It uses `POST /v1/systemone`, not `/chat/completions` or `/responses`. Entries with `metadata.capabilities.task: "decision"` register as `type: "classifier"`, using pi's native System One implementation. They stay out of `/model` and chat model cycling. The current account-visible model is `neuralwatt/clef-flash`; other decision models will be discovered the same way.

Enable pi core's codemode with `"defaultTools": ["+codemode"]` in pi settings, then use its model API:

```js
const clef = await models.getModelOfType("classifier", "neuralwatt", "clef-flash");
if (!clef) return "Reload the provider and check Clef preview access.";
const result = await models.classify(clef, {
  state: { message: "The fix works perfectly, thanks!" },
  questions: {
    sentiment: {
      type: "choice",
      instructions: "Classify the sentiment.",
      criteria: { positive: "Happy", negative: "Unhappy", neutral: "Neither" }
    },
    approved: {
      type: "bool",
      instructions: "Does the user approve the fix?",
      criteria: { true: "Yes", false: "No" }
    },
    urgency: {
      type: "score",
      instructions: "How urgently is further action needed?",
      criteria: ["No action", "Can wait", "Immediate"]
    }
  }
});
return result.stopReason === "stop" ? result.answers : result.errorMessage;
```

Use `models.getAvailableOfType("classifier", "neuralwatt")` to list credential-available classifiers. Availability in pi does not guarantee account enrollment: the bundled preview entry can still return a provider access error. Extensions can use `ctx.modelRegistry.getModelOfType()` and `ctx.modelRegistry.classify()` without codemode.

Pi maps `bool` to the wire's `noul` and back, and supplies choice probabilities, score/confidence, cancellation, retries, request hooks and token-priced usage. Scores are expected zero-based criterion indexes; bool answers are probabilities, not generated text. The same Neuralwatt credentials and configured `baseUrl` apply. There is no fallback to an LLM.

The catalog preserves Clef's advertised image capability; the live smoke test covers JSON/text state, not image/video state encodings. Pi's classifier contract accepts JSON state; consult Neuralwatt's account-visible System One docs for any multimodal wire format rather than sending chat messages.

Classifier usage contributes to pi's codemode totals. The extension's **SSE energy widget does not account for classifier JSON responses**; those calls remain visible in Neuralwatt usage records. Pi's token-list cost is not the energy-billed amount.

## Hosted tools: explicit opt-in

In `~/.pi/agent/extensions/neuralwatt.json`:

```json
{
  "hostedTools": {
    "tools": ["nw_web_search", "nw_check_budget"],
    "budget": { "max_cost_usd": 0.05, "max_energy_wh": 2 }
  }
}
```

Supported names: `nw_web_search`, `nw_check_budget`, `nw_consult`, `nw_look`. `nw_spawn_subagents` is documented upstream but not offered in the preview and is deliberately excluded.

- **Omitted**: leave your dashboard defaults alone; the extension opts into nothing.
- **`false`**: send `X-NW-Tools-Opt-Out: true` to disable all hosted tools for chat requests, including dashboard defaults.
- **Object**: name those tools on every request using the correct Chat Completions or Responses tool shape. Existing local tools are preserved. `tools: []` can attach a budget to dashboard-enabled tools without requesting new ones.
- Budget fields bound **delegated tool work**, not the parent completion. Set the parent output limit separately. A caller can tighten, but not loosen, a configured ceiling. Zero is valid.
- Invalid names, unknown configuration/budget keys, negative or non-numeric budgets fail closed to opt-out, never silently enable unbounded tool spending.

The selected model must advertise `hosted_tools: true` for your key. Access, model support, account toggles and plan limits remain enforced by Neuralwatt. A dashboard tool explicitly switched off cannot be enabled by a request. Without eligibility, upstream may pass the named function back as a client tool; this extension does **not** implement those tools locally. Check account settings if an unknown `nw_*` tool is returned.

Hosted tools run remotely inside the response; local pi tool approval hooks do not govern that work. Search sends model-chosen queries to an external search provider and returns untrusted web text. Consult/look perform additional billable inference. No account settings are changed by this extension. Change the tool set between conversations to avoid invalidating long cached prefixes.

See [Hosted Tools](https://docs.neuralwatt.com/hosted-tools/overview) and [budget semantics](https://docs.neuralwatt.com/hosted-tools/initial-set).

## Sampling and structured output

Per-model defaults now survive the extension's config/merge/registration pipeline:

```json
{
  "modelOverrides": {
    "glm-5.3": {
      "samplingParams": { "top_k": 20, "top_p": 0.95, "repetition_penalty": 1.05, "seed": 42 }
    }
  }
}
```

No temperature/top-p defaults are forced: omit them to use Neuralwatt's model-recommended defaults. Request-level `samplingParams` override model defaults per key. For an extraction/helper call on Chat Completions, pass `samplingParams: { response_format: { type: "json_object" } }` or `json_schema` as described in [Structured Outputs](https://docs.neuralwatt.com/guides/structured-outputs). Do not impose JSON-only output on a normal coding-agent conversation. Responses uses its own `text.format` shape instead of `response_format`.

## Images, lanes and other changelog changes

| Feature | Provider behavior |
| --- | --- |
| `max_images` / `max_images_total` | Distinct `vision.maxImagesPerTurn` / `vision.maxImagesPerRequest`. Old cached catalogs are upgraded. The latest user message and subsequent tool results form the current turn; only its excess images are removed before whole-history FIFO/hysteresis applies. Most current models advertise 20/200; Gemma advertises 4/4. |
| Larger context/output limits, new models, discounted flex pricing | Regenerated from authenticated metadata; curated `patch.json` and user overrides still win. |
| Speed lanes | Select the existing `-speed` model ID. It may fall back to standard; actual `service_tier` is recorded in chat energy events. Speed bills on energy, not its catalog token estimate. [Guide](https://docs.neuralwatt.com/guides/speed-tier). |
| Flex on Responses | `"api": "responses"` works with `-flex` IDs. Live streaming currently has keepalives but no energy/cost SSE comments, so the widget cannot report those requests' energy. |
| Hosted Responses web search | The hosted-tool opt-in emits the documented flat function form. Callers may also use Responses `web_search` through `onPayload`; it is not injected by default. |
| JSON support, strict tools, sampling/default fixes | Server-side fixes work through pi's existing transport. No model-specific workaround is needed. |
| MiMo audio input | Upstream supports audio, but pi's current message input contract is text/image. This extension does not invent an incompatible audio attachment type. |
| Energy matrix and portal/billing changes | The [energy-pricing matrix](https://portal.neuralwatt.com/api/energy-pricing/matrix) publishes speed-lane rows. Portal meters, billing cycles, allowances and account security remain server-side; the widget continues using measured request energy/cost, not matrix estimates. |

## Verification

Offline: `bun run check` and `bun run test:pi`. The latter loads both extension entrypoints in real pi, checks classifier/chat separation, exercises System One through ModelRuntime, and checks ordinary chat/tool/abort behavior. `PI1_HOST_PACKAGE` and `PI1_HOST_ENTRY=bundle` also test an installed Pi 1.0 host.

Explicitly billable live probe, with the key captured by the shell and never printed:

```sh
NEURALWATT_API_KEY="$(localterm secret get neuralwatt_api_key)" bun run probe:capabilities
# Include small LLM, speed, flex Responses and image-history requests:
NEURALWATT_API_KEY="$(localterm secret get neuralwatt_api_key)" bun run probe:capabilities --extended
# Rerun only a particular probe:
NEURALWATT_API_KEY="$(localterm secret get neuralwatt_api_key)" bun run probe:capabilities --only=chat
```

The probe uses an isolated temporary pi directory, does not persist credentials or change account configuration, and reports when hosted tools cannot be tested with the key. Do not enable shell tracing around secret commands.
