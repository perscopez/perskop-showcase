import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { MemoryStore } from "../../src/db.js";
import { registerNodeRoutes } from "../../src/api/nodeRoutes.js";
import { NodeService } from "../../src/tasks/nodeService.js";
import { TaskService } from "../../src/tasks/taskService.js";

const auth = async (request: any, reply: any) =>
  request.headers.authorization === "Bearer owner-token"
    ? undefined
    : reply.code(401).send({ error: "unauthorized" });

async function buildApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-cross-device-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  registerNodeRoutes(app, auth, memory);
  app.get("/api/tasks", { preHandler: auth }, async (request) => {
    const query = request.query as { limit?: string };
    return { items: memory.listTasks(Number(query.limit ?? 20)) };
  });
  app.post("/api/tasks/:id/cancel", { preHandler: auth }, async (request, reply) => {
    const taskId = Number((request.params as { id: string }).id);
    const row = memory.db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId) as
      | { revision: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: "task_not_found" });
    const result = new TaskService(memory).transition(taskId, {
      to: "cancelled",
      expectedRevision: row.revision,
      fields: { cancellation_state: "cancelled" },
    });
    if (!result.applied && result.reason !== "duplicate_event") {
      return reply.code(409).send({ error: result.reason, taskId, state: result.status });
    }
    return { ok: true, taskId, state: "cancelled" };
  });
  await app.ready();
  return { dir, memory, app };
}

test("cross-device: offline queue, reconnect single-claim, Telegram cancel beats late complete, restart reconcile", async () => {
  const evidence: Record<string, unknown> = {
    kind: "staging_e2e",
    label: "cross-device-task-continuity",
    startedAt: new Date().toISOString(),
    steps: [] as Array<Record<string, unknown>>,
  };
  const steps = evidence.steps as Array<Record<string, unknown>>;

  const { dir, memory, app } = await buildApp();
  const owner = { authorization: "Bearer owner-token" };
  const tasks = new TaskService(memory);
  const nodes = new NodeService(memory);

  // 1) Register Mac, then go offline before claiming.
  const register = await app.inject({
    method: "POST",
    url: "/api/nodes/register",
    headers: owner,
    payload: { nodeId: "mac", displayName: "MacBook", capabilities: ["session_control"] },
  });
  assert.equal(register.statusCode, 200);
  const token = register.json().token as string;
  const nodeHeaders = { authorization: `Bearer ${token}`, "x-perskop-node-id": "mac" };
  steps.push({ step: "register", ok: true });

  const offlineTask = memory.addTask({ source: "telegram", prompt: "Do offline work", status: "pending" });
  tasks.transition(offlineTask, { to: "waiting_for_node", expectedRevision: 1 });
  nodes.assignTask({ taskId: offlineTask, targetNodeId: "mac", parentSessionId: "sess-offline" });
  assert.equal(memory.getTaskStatus(offlineTask), "waiting_for_node");
  steps.push({ step: "offline_queue", taskId: offlineTask, status: "waiting_for_node" });

  // 2) Reconnect: heartbeat + single claim.
  await app.inject({
    method: "POST",
    url: "/api/nodes/mac/heartbeat",
    headers: nodeHeaders,
    payload: {
      capabilities: ["session_control"],
      currentLoad: 1,
      sessions: [{ sessionId: "sess-offline", title: "Offline", status: "active", provider: "cursor" }],
    },
  });
  const pending = await app.inject({ method: "GET", url: "/api/nodes/mac/tasks", headers: nodeHeaders });
  assert.equal(pending.json().items.length, 1);

  const claimA = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${offlineTask}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  assert.equal(claimA.statusCode, 200);
  const claimB = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${offlineTask}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  assert.equal(claimB.statusCode, 409);
  assert.equal(memory.getTaskStatus(offlineTask), "running");
  steps.push({ step: "reconnect_single_claim", revision: claimA.json().revision, duplicateRejected: true });

  await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${offlineTask}/progress`,
    headers: nodeHeaders,
    payload: { expectedRevision: claimA.json().revision, message: "working", percent: 35 },
  });

  // 3) Owner/Telegram inspect same live state.
  const listed = await app.inject({ method: "GET", url: "/api/tasks?limit=5", headers: owner });
  assert.equal(listed.statusCode, 200);
  const live = listed.json().items.find((item: any) => item.id === offlineTask);
  assert.equal(live.status, "running");
  const nodeList = await app.inject({ method: "GET", url: "/api/nodes", headers: owner });
  assert.equal(nodeList.json().items[0].online, true);
  steps.push({ step: "telegram_and_app_inspect", status: live.status, nodeOnline: true });

  // 4) Cancel from owner path; Mac late complete discarded.
  const cancel = await app.inject({
    method: "POST",
    url: `/api/tasks/${offlineTask}/cancel`,
    headers: owner,
  });
  assert.equal(cancel.statusCode, 200);
  const late = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${offlineTask}/complete`,
    headers: nodeHeaders,
    payload: { expectedRevision: Number(claimA.json().revision) + 1, response: "late success", provider: "mac_node" },
  });
  assert.equal(late.statusCode, 409);
  assert.equal(memory.getTaskStatus(offlineTask), "cancelled");
  steps.push({ step: "cancel_beats_late_complete", finalStatus: "cancelled" });

  // 5) Restart gateway process (new app on same DB) and reconcile a second task.
  await app.close();
  const app2 = Fastify();
  registerNodeRoutes(app2, auth, memory);
  await app2.ready();
  const restartTask = memory.addTask({ source: "telegram", prompt: "After restart", status: "pending" });
  tasks.transition(restartTask, { to: "waiting_for_node", expectedRevision: 1 });
  nodes.assignTask({ taskId: restartTask, targetNodeId: "mac" });
  await app2.inject({
    method: "POST",
    url: "/api/nodes/mac/heartbeat",
    headers: nodeHeaders,
    payload: { capabilities: ["session_control"], sessions: [] },
  });
  const claimRestart = await app2.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${restartTask}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  assert.equal(claimRestart.statusCode, 200);
  const completeRestart = await app2.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${restartTask}/complete`,
    headers: nodeHeaders,
    payload: {
      expectedRevision: claimRestart.json().revision,
      response: "restart reconciled",
      provider: "mac_node",
    },
  });
  assert.equal(completeRestart.statusCode, 200);
  assert.equal(memory.getTaskStatus(restartTask), "succeeded");
  assert.equal(memory.getTaskStatus(offlineTask), "cancelled");
  steps.push({
    step: "restart_reconcile",
    cancelledStillCancelled: true,
    restartedTaskStatus: "succeeded",
  });

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
  evidence.summary = {
    offlineQueued: true,
    singleClaim: true,
    cancelWins: true,
    restartSafe: true,
  };

  // Optional: persist evidence JSON when PERSKOP_EVIDENCE_DIR is set.
  const evidenceRoot = process.env.PERSKOP_EVIDENCE_DIR;
  if (evidenceRoot) {
    const outDir = path.join(evidenceRoot, "cross-device");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "cross-device-continuity.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }

  await app2.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
