import type { NotifyChannel } from "./notify.ts";
import type { TrackedTask } from "./state.ts";
import { mapRawState } from "./task-status.ts";

export type DeliveryState = "not_configured" | "pending" | "delivered" | "failed";

export type DeliveryField = DeliveryState;

export function deliveryForTask(
  task: TrackedTask,
  activeChannels: NotifyChannel[],
): DeliveryField {
  if (activeChannels.length === 0) return "not_configured";
  if (task.notified_at || task.delivery_record?.status === "delivered") return "delivered";
  if (task.delivery_record?.status === "failed" || task.delivery?.status === "failed") return "failed";
  return "pending";
}

export function shouldSpawnWatcher(activeChannels: NotifyChannel[]): boolean {
  return activeChannels.length > 0;
}

export function webhookPayloadId(taskId: string, rawState: string): string {
  const mapped = mapRawState(rawState);
  return `${taskId}:${mapped.status}`;
}