import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import Fastify from "fastify";
import { MemoryStore } from "../../src/db.js";
import { registerApiRoutes } from "../../src/api/routes.js";
import type { AppConfig } from "../../src/config.js";

test("task cancellation revokes tokens, persists cancelled state, and calls executor cleanup", async () => {
  const dir = `./test-cancel-${crypto.randomBytes(8).toString("hex")}`;
  const memory = new MemoryStore(dir);
  const taskId = memory.addTask({ source: "mac", prompt: "long task" });
  const approvalId = crypto.randomUUID();
  memory.createApproval({
    id: approvalId,
    taskId,
    requestedBy: "mac",
    channelId: "api",
    sessionId: "default",
    operationType: "repository_write",
    canonicalPayload: "{}",
    payloadHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "cancel-test",
  });
  memory.setApprovalStatus(approvalId, "approved", "owner");
  assert.equal(memory.claimApproval(approvalId), true);
  const scopedToken = memory.issueScopedToken({ taskId, executorIdentity: "sandbox-executor" });
  const config = {
    PERSKOP_API_TOKEN: "test-cancel-token",
    PERSKOP_EXECUTOR_URL: "http://executor",
    PERSKOP_EXECUTOR_TOKEN: "executor-secret",
    DATA_DIR: dir,
  } as AppConfig;
  const app = Fastify();
  await registerApiRoutes(app, config, memory);
  const originalFetch = globalThis.fetch;
  let cancellationCalled = false;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    if (String(url) === `http://executor/cancel/${taskId}`) {
      cancellationCalled = init?.method === "POST" && init.headers?.Authorization === "Bearer executor-secret";
      return Response.json({ ok: true, taskId, cancelled: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/cancel`,
      headers: { authorization: "Bearer test-cancel-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(cancellationCalled, true);
    assert.equal((memory.listTasks(1)[0] as any).status, "cancelled");
    assert.equal(memory.getApproval(approvalId)?.status, "consumed");
    assert.equal(memory.validateScopedToken(scopedToken, "sandbox-executor"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    memory.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
