const HOSTED_TOOL_NAMES = ["nw_check_budget", "nw_consult", "nw_look", "nw_web_search"] as const;
type HostedToolName = typeof HOSTED_TOOL_NAMES[number];

export type HostedToolsConfig = false | {
  tools: HostedToolName[];
  budget?: { max_cost_usd?: number; max_energy_wh?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Invalid opt-ins fail closed: never drop an invalid budget and enable paid tools. */
export function parseHostedTools(value: unknown): HostedToolsConfig | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!isRecord(value) || Object.keys(value).some(k => k !== "tools" && k !== "budget")) return false;
  if (!Array.isArray(value.tools) || value.tools.some(n => !HOSTED_TOOL_NAMES.includes(n as HostedToolName))) return false;
  const result: Exclude<HostedToolsConfig, false> = { tools: [...new Set(value.tools)] as HostedToolName[] };
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) return false;
    const budget: NonNullable<typeof result.budget> = {};
    for (const [key, amount] of Object.entries(value.budget)) {
      if ((key !== "max_cost_usd" && key !== "max_energy_wh") ||
          typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
      budget[key] = amount;
    }
    result.budget = budget;
  }
  return result;
}

/** Hosted calls execute at the gateway, never as local pi tools. */
export function applyHostedTools(payload: any, responses: boolean, config: HostedToolsConfig | undefined, supported?: boolean): any {
  if (!config) return payload;
  if (config.tools.length > 0 && supported !== true) {
    throw new Error("This model does not advertise Neuralwatt hosted tools. Check preview access and refresh the catalog, or remove hostedTools from neuralwatt.json.");
  }
  const tools = [...(payload.tools ?? [])];
  for (const name of config.tools) {
    if (tools.some(tool => (responses ? tool.name : tool.function?.name) === name)) continue;
    tools.push(responses ? { type: "function", name } : { type: "function", function: { name } });
  }
  const metadata = { ...payload.metadata };
  if (config.budget) {
    const budget = { ...metadata.hosted_tools_budget };
    // A caller may tighten a configured ceiling, never loosen it accidentally.
    for (const [key, cap] of Object.entries(config.budget)) {
      const caller = budget[key];
      budget[key] = typeof caller === "number" && Number.isFinite(caller) && caller >= 0 ? Math.min(caller, cap) : cap;
    }
    metadata.hosted_tools_budget = budget;
  }
  return { ...payload, ...(config.tools.length ? { tools } : {}), ...(config.budget ? { metadata } : {}) };
}
