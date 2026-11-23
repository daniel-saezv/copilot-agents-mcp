export type ToolMethod = "GET" | "POST";

export type ToolName =
  | "create_agent_task"
  | "get_agent_task"
  | "list_agent_tasks"
  | "steer_agent_task"
  | "abort_agent_task"
  | "list_copilot_models";

export const TOOL_NAMES: readonly ToolName[] = [
  "create_agent_task",
  "get_agent_task",
  "list_agent_tasks",
  "steer_agent_task",
  "abort_agent_task",
  "list_copilot_models",
];

export const TOOLS: readonly { name: ToolName; method: ToolMethod }[] = [
  { name: "create_agent_task", method: "POST" },
  { name: "get_agent_task", method: "GET" },
  { name: "list_agent_tasks", method: "GET" },
  { name: "steer_agent_task", method: "POST" },
  { name: "abort_agent_task", method: "POST" },
  { name: "list_copilot_models", method: "GET" },
];

export function toolNames(): ToolName[] {
  return [...TOOL_NAMES];
}