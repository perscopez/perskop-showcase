import test from "node:test";
import assert from "node:assert/strict";
import {
  transitionTaskState,
  type TaskState,
} from "../../src/tasks/stateMachine.js";

const state = (status: TaskState["status"], revision = 1): TaskState => ({
  status,
  revision,
});

test("task state machine applies valid transitions with monotonically increasing revisions", () => {
  const queued = transitionTaskState(state("pending"), {
    to: "queued",
    expectedRevision: 1,
  });
  assert.deepEqual(queued, {
    applied: true,
    status: "queued",
    revision: 2,
  });

  const running = transitionTaskState(
    { status: queued.status, revision: queued.revision },
    { to: "running", expectedRevision: 2 },
  );
  assert.deepEqual(running, {
    applied: true,
    status: "running",
    revision: 3,
  });
});

test("terminal tasks reject reversal and cancellation wins over late completion", () => {
  const cancelled = transitionTaskState(state("running", 4), {
    to: "cancelled",
    expectedRevision: 4,
  });
  assert.deepEqual(cancelled, {
    applied: true,
    status: "cancelled",
    revision: 5,
  });

  const lateSuccess = transitionTaskState(
    { status: cancelled.status, revision: cancelled.revision },
    { to: "succeeded", expectedRevision: 5 },
  );
  assert.deepEqual(lateSuccess, {
    applied: false,
    status: "cancelled",
    revision: 5,
    reason: "terminal_state",
  });

  assert.deepEqual(
    transitionTaskState(state("succeeded", 8), {
      to: "running",
      expectedRevision: 8,
    }),
    {
      applied: false,
      status: "succeeded",
      revision: 8,
      reason: "terminal_state",
    },
  );
});

test("duplicate events are idempotent and stale revisions are rejected", () => {
  assert.deepEqual(
    transitionTaskState(state("running", 3), {
      to: "running",
      expectedRevision: 3,
    }),
    {
      applied: false,
      status: "running",
      revision: 3,
      reason: "duplicate_event",
    },
  );

  assert.deepEqual(
    transitionTaskState(state("queued", 7), {
      to: "running",
      expectedRevision: 6,
    }),
    {
      applied: false,
      status: "queued",
      revision: 7,
      reason: "revision_conflict",
    },
  );
});

test("invalid non-terminal transitions are rejected without changing state", () => {
  assert.deepEqual(
    transitionTaskState(state("pending", 2), {
      to: "succeeded",
      expectedRevision: 2,
    }),
    {
      applied: false,
      status: "pending",
      revision: 2,
      reason: "invalid_transition",
    },
  );
});
