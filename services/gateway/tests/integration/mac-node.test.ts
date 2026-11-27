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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-mac-node-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  registerNodeRoutes(app, auth, memory);
  await app.ready();
  return { dir, memory, app };
}

test("Mac node registration, heartbeat, claim-once, progress and completion", async () => {
  const { dir, memory, app } = await buildApp();
  const headers = { authorization: "Bearer owner-token" };

  const register = await app.inject({
    method: "POST",
    url: "/api/nodes/register",
    headers,
    payload: {
      nodeId: "mac",
      displayName: "MacBook",
      appVersion: "0.17.0",
      capabilities: ["session_control", "repository_write"],
    },
  });
  assert.equal(register.statusCode, 200);
  const token = register.json().token as string;
  assert.ok(token);

  const nodeHeaders = { authorization: `Bearer ${token}`, "x-perskop-node-id": "mac" };
  const heartbeat = await app.inject({
    method: "POST",
    url: "/api/nodes/mac/heartbeat",
    headers: nodeHeaders,
    payload: {
      capabilities: ["session_control", "repository_write"],
      currentLoad: 0,
      sessions: [{ sessionId: "s1", title: "Dev", status: "active", provider: "cursor" }],
    },
  });
  assert.equal(heartbeat.statusCode, 200);

  const taskId = memory.addTask({ source: "telegram", prompt: "Run on Mac", status: "pending" });
  new TaskService(memory).transition(taskId, { to: "waiting_for_node", expectedRevision: 1 });
  new NodeService(memory).assignTask({ taskId, targetNodeId: "mac", parentSessionId: "s1" });

  const pending = await app.inject({ method: "GET", url: "/api/nodes/mac/tasks", headers: nodeHeaders });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().items.length, 1);

  const claim = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().revision, 3);

  const claimAgain = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  assert.equal(claimAgain.statusCode, 409);

  const progress = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/progress`,
    headers: nodeHeaders,
    payload: { expectedRevision: 3, message: "working", percent: 40 },
  });
  assert.equal(progress.statusCode, 200);

  const complete = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/complete`,
    headers: nodeHeaders,
    payload: { expectedRevision: 3, response: "done on mac", provider: "cursor" },
  });
  assert.equal(complete.statusCode, 200);
  assert.equal(memory.getTaskStatus(taskId), "succeeded");

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("offline target stays waiting_for_node and revoked tokens are rejected", async () => {
  const { dir, memory, app } = await buildApp();
  const headers = { authorization: "Bearer owner-token" };
  const register = await app.inject({
    method: "POST",
    url: "/api/nodes/register",
    headers,
    payload: { nodeId: "mac", displayName: "MacBook", capabilities: ["session_control"] },
  });
  const token = register.json().token as string;

  const taskId = memory.addTask({ source: "telegram", prompt: "Wait", status: "pending" });
  new TaskService(memory).transition(taskId, { to: "waiting_for_node", expectedRevision: 1 });
  new NodeService(memory).assignTask({ taskId, targetNodeId: "mac" });
  assert.equal(memory.getTaskStatus(taskId), "waiting_for_node");

  const revoke = await app.inject({ method: "POST", url: "/api/nodes/mac/revoke", headers });
  assert.equal(revoke.statusCode, 200);

  const heartbeat = await app.inject({
    method: "POST",
    url: "/api/nodes/mac/heartbeat",
    headers: { authorization: `Bearer ${token}`, "x-perskop-node-id": "mac" },
    payload: { capabilities: ["session_control"], sessions: [] },
  });
  assert.equal(heartbeat.statusCode, 401);

  const stale = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/complete`,
    headers: { authorization: `Bearer ${token}`, "x-perskop-node-id": "mac" },
    payload: { expectedRevision: 2, response: "late", provider: "cursor" },
  });
  assert.equal(stale.statusCode, 401);
  assert.equal(memory.getTaskStatus(taskId), "waiting_for_node");

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancellation wins over late Mac completion", async () => {
  const { dir, memory, app } = await buildApp();
  const headers = { authorization: "Bearer owner-token" };
  const register = await app.inject({
    method: "POST",
    url: "/api/nodes/register",
    headers,
    payload: { nodeId: "mac", displayName: "MacBook", capabilities: ["repository_write"] },
  });
  const token = register.json().token as string;
  const nodeHeaders = { authorization: `Bearer ${token}`, "x-perskop-node-id": "mac" };
  await app.inject({
    method: "POST",
    url: "/api/nodes/mac/heartbeat",
    headers: nodeHeaders,
    payload: { capabilities: ["repository_write"], sessions: [] },
  });

  const taskId = memory.addTask({ source: "telegram", prompt: "Cancel me", status: "pending" });
  const tasks = new TaskService(memory);
  tasks.transition(taskId, { to: "waiting_for_node", expectedRevision: 1 });
  new NodeService(memory).assignTask({ taskId, targetNodeId: "mac" });
  await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/claim`,
    headers: nodeHeaders,
    payload: { expectedRevision: 2 },
  });
  tasks.transition(taskId, { to: "cancelled", expectedRevision: 3, fields: { cancellation_state: "cancelled" } });

  const late = await app.inject({
    method: "POST",
    url: `/api/nodes/mac/tasks/${taskId}/complete`,
    headers: nodeHeaders,
    payload: { expectedRevision: 4, response: "too late", provider: "cursor" },
  });
  assert.equal(late.statusCode, 409);
  assert.equal(memory.getTaskStatus(taskId), "cancelled");

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
