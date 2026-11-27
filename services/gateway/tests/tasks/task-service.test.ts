import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { TaskService } from "../../src/tasks/taskService.js";

test("task service persists revisions and rejects stale or late terminal events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-task-service-"));
  const memory = new MemoryStore(dir);
  const tasks = new TaskService(memory);
  const taskId = memory.addTask({
    source: "mac",
    prompt: "Run a bounded task",
    status: "pending",
  });

  const queued = tasks.transition(taskId, {
    to: "queued",
    expectedRevision: 1,
    fields: { workload: "repository_write" },
  });
  assert.deepEqual(queued, {
    applied: true,
    status: "queued",
    revision: 2,
  });

  const stale = tasks.transition(taskId, {
    to: "running",
    expectedRevision: 1,
  });
  assert.deepEqual(stale, {
    applied: false,
    status: "queued",
    revision: 2,
    reason: "revision_conflict",
  });

  const running = tasks.transition(taskId, {
    to: "running",
    expectedRevision: 2,
  });
  assert.equal(running.applied, true);
  assert.equal(running.revision, 3);

  const cancelled = tasks.transition(taskId, {
    to: "cancelled",
    expectedRevision: 3,
    fields: { cancellation_state: "cancelled" },
  });
  assert.equal(cancelled.applied, true);
  assert.equal(cancelled.revision, 4);

  const late = tasks.transition(taskId, {
    to: "succeeded",
    expectedRevision: 4,
    fields: { response: "late output", provider: "codex" },
  });
  assert.deepEqual(late, {
    applied: false,
    status: "cancelled",
    revision: 4,
    reason: "terminal_state",
  });

  const row = memory.db.prepare(`
    SELECT status,revision,response,provider,workload,cancellation_state
    FROM tasks WHERE id=?
  `).get(taskId) as Record<string, unknown>;
  assert.deepEqual(row, {
    status: "cancelled",
    revision: 4,
    response: null,
    provider: null,
    workload: "repository_write",
    cancellation_state: "cancelled",
  });

  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
