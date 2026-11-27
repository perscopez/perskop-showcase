import type { MemoryStore } from "../db.js";
import {
  isTerminalTaskStatus,
  transitionTaskState,
  type TaskStatus,
  type TaskTransitionResult,
} from "./stateMachine.js";

export type TaskTransitionFields = Partial<{
  response: string | null;
  provider: string | null;
  error: string | null;
  workload: string | null;
  engine: string | null;
  proposed_operation: string | null;
  approval_id: string | null;
  expected_outcome: string | null;
  deadline: string | null;
  cancellation_state: string | null;
  verification_result: string | null;
  structured_error: string | null;
  routing_trace: string | null;
}>;

const transitionFieldNames = new Set<keyof TaskTransitionFields>([
  "response",
  "provider",
  "error",
  "workload",
  "engine",
  "proposed_operation",
  "approval_id",
  "expected_outcome",
  "deadline",
  "cancellation_state",
  "verification_result",
  "structured_error",
  "routing_trace",
]);

export class TaskService {
  constructor(private readonly memory: MemoryStore) {}

  transition(
    taskId: number,
    input: {
      to: TaskStatus;
      expectedRevision: number;
      fields?: TaskTransitionFields;
    },
  ): TaskTransitionResult {
    const transaction = this.memory.db.transaction(() => {
      const current = this.memory.db.prepare(
        "SELECT status,revision FROM tasks WHERE id=?",
      ).get(taskId) as { status: TaskStatus; revision: number } | undefined;
      if (!current) throw new Error("task_not_found");

      const transition = transitionTaskState(current, input);
      if (!transition.applied) return transition;

      const sets = ["status=@status", "revision=@revision"];
      const params: Record<string, unknown> = {
        id: taskId,
        expectedRevision: current.revision,
        status: transition.status,
        revision: transition.revision,
      };
      for (const [key, value] of Object.entries(input.fields ?? {})) {
        if (!transitionFieldNames.has(key as keyof TaskTransitionFields) || value === undefined) continue;
        sets.push(`${key}=@${key}`);
        params[key] = value;
      }
      if (isTerminalTaskStatus(transition.status)) {
        sets.push("completed_at=datetime('now')");
      }

      const update = this.memory.db.prepare(`
        UPDATE tasks
        SET ${sets.join(", ")}
        WHERE id=@id AND revision=@expectedRevision
      `).run(params);
      if (update.changes !== 1) {
        const latest = this.memory.db.prepare(
          "SELECT status,revision FROM tasks WHERE id=?",
        ).get(taskId) as { status: TaskStatus; revision: number };
        return {
          ...latest,
          applied: false as const,
          reason: "revision_conflict" as const,
        };
      }
      return transition;
    });

    const result = transaction();
    if (result.applied && isTerminalTaskStatus(result.status)) {
      this.memory.revokeScopedTokensByTask(taskId);
    }
    return result;
  }
}
