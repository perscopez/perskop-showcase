export type TaskStatus =
  | "pending"
  | "queued"
  | "waiting_approval"
  | "waiting_for_node"
  | "running"
  | "succeeded"
  | "done"
  | "failed"
  | "error"
  | "timed_out"
  | "cancelled"
  | "rejected";

export type TaskState = {
  status: TaskStatus;
  revision: number;
};

export type TaskTransitionReason =
  | "duplicate_event"
  | "invalid_transition"
  | "revision_conflict"
  | "terminal_state";

export type TaskTransitionResult = TaskState & (
  | { applied: true }
  | { applied: false; reason: TaskTransitionReason }
);

type NonTerminalTaskStatus = Exclude<TaskStatus,
  "succeeded" | "done" | "failed" | "error" | "timed_out" | "cancelled" | "rejected"
>;

const terminalStatuses = new Set<TaskStatus>([
  "succeeded",
  "done",
  "failed",
  "error",
  "timed_out",
  "cancelled",
  "rejected",
]);

const allowedTransitions: Record<NonTerminalTaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set([
    "queued",
    "waiting_approval",
    "waiting_for_node",
    "running",
    "failed",
    "error",
    "cancelled",
    "rejected",
  ]),
  queued: new Set([
    "waiting_approval",
    "waiting_for_node",
    "running",
    "failed",
    "error",
    "timed_out",
    "cancelled",
    "rejected",
  ]),
  waiting_approval: new Set([
    "queued",
    "waiting_for_node",
    "running",
    "failed",
    "error",
    "cancelled",
    "rejected",
  ]),
  waiting_for_node: new Set([
    "queued",
    "running",
    "failed",
    "error",
    "timed_out",
    "cancelled",
  ]),
  running: new Set([
    "succeeded",
    "done",
    "failed",
    "error",
    "timed_out",
    "cancelled",
    "rejected",
  ]),
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}

export function transitionTaskState(
  current: TaskState,
  event: { to: TaskStatus; expectedRevision: number },
): TaskTransitionResult {
  if (event.expectedRevision !== current.revision) {
    return { ...current, applied: false, reason: "revision_conflict" };
  }
  if (event.to === current.status) {
    return { ...current, applied: false, reason: "duplicate_event" };
  }
  if (isTerminalTaskStatus(current.status)) {
    return { ...current, applied: false, reason: "terminal_state" };
  }
  if (!allowedTransitions[current.status as NonTerminalTaskStatus].has(event.to)) {
    return { ...current, applied: false, reason: "invalid_transition" };
  }
  return {
    status: event.to,
    revision: current.revision + 1,
    applied: true,
  };
}
