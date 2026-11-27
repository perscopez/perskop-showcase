import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { registerRemoteRoutes } from "../../src/api/remoteRoutes.js";
import { RemoteSessionStore } from "../../src/remote/sessionStore.js";
import { waitForRemoteCommandResult } from "../../src/remote/commandBroker.js";

test("remote session API registers a Mac and delivers one-shot focus commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-remote-api-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  registerRemoteRoutes(app, async (request, reply) => request.headers.authorization === "Bearer token" ? undefined : reply.code(401).send({ error: "unauthorized" }), memory);

  assert.equal((await app.inject({ method: "GET", url: "/api/remote/sessions" })).statusCode, 401);
  const headers = { authorization: "Bearer token" };
  const heartbeat = await app.inject({
    method: "POST", url: "/api/remote/heartbeat", headers,
    payload: { nodeId: "mac", displayName: "Alex's Mac", appVersion: "1.0.0", sessions: [{ id: "session-abcdef", title: "Perskop geliştirme", preview: "devam", cwd: "/repo", profile: "default", isActive: true, lastActive: 123 }] },
  });
  assert.equal(heartbeat.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/remote/sessions", headers })).json().items[0].session_id, "session-abcdef");
  const store = new RemoteSessionStore(memory.db);
  assert.equal(store.findSession("n-abcdef")?.session_id, "session-abcdef");

  const queued = await app.inject({ method: "POST", url: "/api/remote/commands", headers, payload: { nodeId: "mac", action: "focus_session", sessionId: "session-abcdef" } });
  assert.equal(queued.statusCode, 200);
  const command = queued.json().item;
  const pending = await app.inject({ method: "GET", url: "/api/remote/nodes/mac/commands", headers });
  assert.equal(pending.json().items.length, 1);
  assert.equal(pending.json().items[0].session_id, "session-abcdef");
  assert.equal((await app.inject({ method: "POST", url: `/api/remote/nodes/mac/commands/${command.id}/complete`, headers, payload: { ok: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/remote/nodes/mac/commands", headers })).json().items.length, 0);

  const read = await app.inject({ method: "POST", url: "/api/remote/commands", headers, payload: { nodeId: "mac", action: "read_session", sessionId: "session-abcdef" } });
  const readId = read.json().item.id;
  const waiting = waitForRemoteCommandResult(readId, 100);
  await app.inject({ method: "POST", url: `/api/remote/nodes/mac/commands/${readId}/complete`, headers, payload: { ok: true, result: "bounded transcript" } });
  assert.deepEqual(await waiting, { ok: true, result: "bounded transcript" });
  assert.equal((memory.db.prepare("SELECT error FROM remote_commands WHERE id=?").get(readId) as { error: string | null }).error, null);

  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("remote session heartbeat replaces stale session snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-remote-store-"));
  const memory = new MemoryStore(dir);
  const remote = new RemoteSessionStore(memory.db);
  remote.heartbeat({ nodeId: "mac", displayName: "Mac", sessions: [{ id: "old", title: null, preview: null, cwd: null, profile: null, isActive: false, lastActive: 1 }] });
  remote.heartbeat({ nodeId: "mac", displayName: "Mac", sessions: [{ id: "new", title: null, preview: null, cwd: null, profile: null, isActive: true, lastActive: 2 }] });
  assert.deepEqual(remote.listSessions("mac").map((row: any) => row.session_id), ["new"]);
  const old = remote.queueCommand({ nodeId: "mac", action: "new_session" }) as any;
  assert.equal((remote.queueCommand({ nodeId: "mac", action: "new_session" }) as any).id, old.id);
  memory.db.prepare("UPDATE remote_commands SET status='completed',completed_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(old.id);
  assert.equal(remote.pruneCommands(Date.parse("2026-07-18T00:00:00.000Z")), 1);
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("send_prompt commands keep prompt text transient and never deduplicate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-remote-prompt-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  registerRemoteRoutes(app, async () => undefined, memory);
  await app.inject({
    method: "POST",
    url: "/api/remote/heartbeat",
    payload: { nodeId: "mac", displayName: "Mac", sessions: [{ id: "session-1", isActive: true, lastActive: 1 }] },
  });
  const payload = { nodeId: "mac", action: "send_prompt", sessionId: "session-1", prompt: "private prompt text" };

  const first = await app.inject({ method: "POST", url: "/api/remote/commands", payload });
  const second = await app.inject({ method: "POST", url: "/api/remote/commands", payload: { ...payload, prompt: "second private prompt" } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.notEqual(first.json().item.id, second.json().item.id);
  assert.doesNotMatch(JSON.stringify(memory.db.prepare("SELECT * FROM remote_commands").all()), /private prompt/);

  const pending = await app.inject({ method: "GET", url: "/api/remote/nodes/mac/commands" });
  assert.deepEqual(pending.json().items.map((item: any) => item.payload?.prompt), ["private prompt text", "second private prompt"]);

  const firstId = first.json().item.id;
  const waiting = waitForRemoteCommandResult(firstId, 100);
  const result = "x".repeat(20_000);
  const completed = await app.inject({
    method: "POST",
    url: `/api/remote/nodes/mac/commands/${firstId}/complete`,
    payload: { ok: true, result },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal((await waiting)?.result, result);

  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
