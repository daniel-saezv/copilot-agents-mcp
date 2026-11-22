export const TOOLSETS = {
  copilot_tasks: { feature: null },
  copilot_models: { feature: null },
  copilot_automations: { feature: "agent_automations" },
  copilot_agent_merge: { feature: "agent_merge" },
} as const;

export type ToolsetName = keyof typeof TOOLSETS;

export const FEATURES = ["agent_automations", "agent_merge"] as const;

export const DEFAULT_TOOLSETS: ToolsetName[] = ["copilot_tasks", "copilot_models"];

export type ToolMethod = "GET" | "POST";

export type ToolDefinition = {
  name: string;
  toolset: ToolsetName;
  method: ToolMethod;
};

export const TOOLS: readonly ToolDefinition[] = [
  { name: "create_agent_task", toolset: "copilot_tasks", method: "POST" },
  { name: "get_agent_task", toolset: "copilot_tasks", method: "GET" },
  { name: "steer_agent_task", toolset: "copilot_tasks", method: "POST" },
  { name: "abort_agent_task", toolset: "copilot_tasks", method: "POST" },
  { name: "get_agent_task_events", toolset: "copilot_tasks", method: "GET" },
  { name: "list_copilot_models", toolset: "copilot_models", method: "GET" },
];

export type Selection = {
  toolsets?: string[];
  tools?: string[];
  exclude: string[];
  readOnly: boolean;
  features: string[];
};

export function selectToolNames(selection: Selection): string[] {
  assertSelection(selection);
  const features = new Set(selection.features);
  const requestedToolsets = selection.toolsets ?? (selection.tools ? [] : [...DEFAULT_TOOLSETS]);
  const names = new Set<string>();
  for (const tool of TOOLS) {
    if (!featureAllows(tool.toolset, features)) continue;
    if (requestedToolsets.includes(tool.toolset)) names.add(tool.name);
  }
  for (const name of selection.tools ?? []) {
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool || !featureAllows(tool.toolset, features)) continue;
    names.add(name);
  }
  for (const name of selection.exclude) names.delete(name);
  if (selection.readOnly) {
    for (const name of [...names]) {
      const tool = TOOLS.find((item) => item.name === name);
      if (tool && tool.method !== "GET") names.delete(name);
    }
  }
  return TOOLS.map((tool) => tool.name).filter((name) => names.has(name));
}

export function assertSelection(selection: Selection): void {
  for (const feature of selection.features) {
    if (!FEATURES.includes(feature as (typeof FEATURES)[number])) {
      throw new Error(`Feature desconocida: ${feature}.`);
    }
  }
  for (const name of selection.toolsets ?? []) {
    if (!isToolset(name)) throw new Error(`Toolset desconocido: ${name}.`);
    const feature = TOOLSETS[name].feature;
    if (feature && !selection.features.includes(feature)) {
      throw new Error(`El toolset ${name} requiere --features=${feature}.`);
    }
  }
  for (const name of selection.tools ?? []) {
    if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Herramienta desconocida: ${name}.`);
  }
}

export function selectionFromHttp(url: string, headers: Headers, base: Selection): Selection {
  const parsed = new URL(url, "http://127.0.0.1");
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const toolsetMatch = /^(?:\/mcp)?\/x\/([^/]+)$/.exec(path);
  const readOnlyPath = path === "/readonly" || path === "/mcp/readonly";
  const known = path === "/" || path === "/mcp" || readOnlyPath || toolsetMatch !== null;
  if (!known) throw new Error("Ruta desconocida.");
  const selection: Selection = {
    exclude: [...base.exclude],
    readOnly: base.readOnly,
    features: [...base.features],
  };
  if (base.toolsets) selection.toolsets = [...base.toolsets];
  if (base.tools) selection.tools = [...base.tools];
  if (toolsetMatch?.[1]) selection.toolsets = [decodeURIComponent(toolsetMatch[1])];
  if (readOnlyPath) selection.readOnly = true;
  const headerToolsets = headers.get("x-mcp-toolsets");
  if (headerToolsets !== null) selection.toolsets = splitList(headerToolsets);
  const headerTools = headers.get("x-mcp-tools");
  if (headerTools !== null) selection.tools = splitList(headerTools);
  const headerExclude = headers.get("x-mcp-exclude-tools");
  if (headerExclude !== null) selection.exclude = splitList(headerExclude);
  const headerReadOnly = headers.get("x-mcp-readonly");
  if (headerReadOnly !== null && /^(true|1)$/i.test(headerReadOnly.trim())) selection.readOnly = true;
  if (base.readOnly) selection.readOnly = true;
  const headerFeatures = headers.get("x-mcp-features");
  const queryFeatures = parsed.searchParams.get("features");
  const featureSource = headerFeatures ?? queryFeatures;
  if (featureSource !== null) selection.features = splitList(featureSource);
  return selection;
}

export function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isToolset(name: string): name is ToolsetName {
  return Object.prototype.hasOwnProperty.call(TOOLSETS, name);
}

function featureAllows(toolset: ToolsetName, features: ReadonlySet<string>): boolean {
  const feature = TOOLSETS[toolset].feature;
  return feature === null || features.has(feature);
}
