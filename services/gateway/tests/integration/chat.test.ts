import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import Fastify from "fastify";
import { registerApiRoutes } from "../../src/api/routes.js";
import { MemoryStore } from "../../src/db.js";
import type { AppConfig } from "../../src/config.js";
import fs from "node:fs";

test("E2E Chat Approvals Flow Integration Test", async () => {
  const testDir = `./test-integration-${crypto.randomBytes(8).toString("hex")}`;
  const config: AppConfig = {
    PORT: 8787,
    HOST: "0.0.0.0",
    DATA_DIR: testDir,
    PERSKOP_API_TOKEN: "test-token-123",
    CODEX_CMD: "codex",
    CURSOR_CMD: "cursor-agent",
    OPENCODE_CMD: "opencode",
    AGY_CMD: "agy",
    DEFAULT_PROVIDER: "codex",
    EMAIL_IMAP_HOST: "imap.gmail.com",
    EMAIL_IMAP_PORT: 993,
    EMAIL_SMTP_HOST: "smtp.gmail.com",
    EMAIL_SMTP_PORT: 587,
    CRON_EMAIL_ENABLED: false,
    CRON_MORNING_BRIEF: "0 8 * * *",
    CRON_TZ: "Europe/Istanbul",
    PERSKOP_FULL_ACCESS: true,
    allowedTelegramUserIds: [],
    PERSKOP_LLM_PROXY_URL: "http://mock-proxy",
    PERSKOP_LLM_PROXY_SECRET: "mock-secret",
    PERSKOP_EXECUTOR_URL: "http://mock-executor",
    PERSKOP_EXECUTOR_TOKEN: "mock-token",
  };

  const memory = new MemoryStore(testDir);
  const app = Fastify({ logger: false });
  await registerApiRoutes(app, config, memory);

  const originalFetch = globalThis.fetch;
  let executorShouldFail = false;
  const operation = {
    schemaVersion: 1,
    repositoryId: "perskop-test",
    workingDirectory: "workspace",
    baseCommit: "a".repeat(40),
    allowedPaths: ["README.md", "index.js"],
    patch: "+approved test change\n",
    expectedChangedPaths: ["README.md"],
    engine: "codex",
    timeoutSeconds: 300,
    verificationCommand: ["npm", "test"],
    expectedExitCode: 0,
  };
  globalThis.fetch = (async (url: any, options: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/chat/completions")) {
      const stream = new ReadableStream({
        start(controller) {
          const chunk = JSON.stringify({
            choices: [{ delta: { content: "Mocked direct model response" } }],
          });
          controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    if (urlStr.includes("/execute")) {
      if (executorShouldFail) {
        return new Response("executor failed", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          exitCode: 0,
          output: "Mocked sandbox execution",
          verification: { ok: true },
        }),
        { status: 200 },
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as any;

  try {
    // 1. Direct model interaction (greeting doesn't require approval)
    const resGreeting = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer test-token-123",
      },
      payload: {
        prompt: "Merhaba nasılsın",
      },
    });

    assert.strictEqual(resGreeting.statusCode, 200);
    const jsonGreeting = JSON.parse(resGreeting.payload);
    assert.strictEqual(jsonGreeting.provider, "direct_model");
    assert.ok(jsonGreeting.output.includes("Mocked direct model response"));

    // 2. Repository write operation (requires approval)
    const resWrite = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer test-token-123",
      },
      payload: {
        prompt: "Modify README.md to add status: verified",
        operation,
      },
    });

    assert.strictEqual(resWrite.statusCode, 200);
    const jsonWrite = JSON.parse(resWrite.payload);
    assert.strictEqual(jsonWrite.requiresApproval, true);
    assert.ok(jsonWrite.approvalId);
    assert.ok(jsonWrite.payloadHash);
    assert.ok(jsonWrite.nonce);

    // Verify task is in queued state
    const tasks = memory.listTasks(1);
    assert.strictEqual(tasks[0].status, "queued");
    assert.strictEqual(tasks[0].approval_id, jsonWrite.approvalId);

    // Verify it is listed in pending approvals
    const pendingList = memory.listPendingApprovals();
    assert.strictEqual(pendingList.length, 1);
    assert.strictEqual(pendingList[0].id, jsonWrite.approvalId);

    // 3. Reject approval
    const resReject = await app.inject({
      method: "POST",
      url: `/api/approvals/${jsonWrite.approvalId}/reject`,
      headers: {
        authorization: "Bearer test-token-123",
      },
    });
    assert.strictEqual(resReject.statusCode, 200);

    // Verify task is rejected
    const tasksAfterReject = memory.listTasks(1);
    assert.strictEqual(tasksAfterReject[0].status, "rejected");

    // 4. Request another write, then approve and execute!
    const resWrite2 = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer test-token-123",
      },
      payload: {
        prompt: "Modify index.js",
        operation: {
          ...operation,
          patch: "+approved index change\n",
          expectedChangedPaths: ["index.js"],
        },
      },
    });
    const jsonWrite2 = JSON.parse(resWrite2.payload);

    // Approve it
    const resApprove = await app.inject({
      method: "POST",
      url: `/api/approvals/${jsonWrite2.approvalId}/approve`,
      headers: {
        authorization: "Bearer test-token-123",
      },
    });
    assert.strictEqual(resApprove.statusCode, 200);

    // Submit request again with approvalId
    const resExecute = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer test-token-123",
      },
      payload: {
        prompt: "Modify index.js",
        approvalId: jsonWrite2.approvalId,
        operation: {
          ...operation,
          patch: "+approved index change\n",
          expectedChangedPaths: ["index.js"],
        },
      },
    });
    assert.strictEqual(resExecute.statusCode, 200);
    const jsonExecute = JSON.parse(resExecute.payload);
    assert.strictEqual(jsonExecute.provider, "coding_cli");
    assert.ok(jsonExecute.output.includes("Mocked sandbox execution"));

    // Verify task status is completed
    const finalTasks = memory.listTasks(2);
    const execTask = finalTasks.find((t: any) => t.id === jsonExecute.taskId);
    assert.strictEqual(execTask?.status, "done");

    // Verify approval status is consumed
    const apprStatus = memory.getApproval(jsonWrite2.approvalId);
    assert.strictEqual(apprStatus?.status, "consumed");

    // 5. A claimed approval also becomes terminal when execution fails.
    const resWrite3 = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: "Bearer test-token-123" },
      payload: {
        prompt: "Modify README.md",
        operation,
      },
    });
    const jsonWrite3 = JSON.parse(resWrite3.payload);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${jsonWrite3.approvalId}/approve`,
      headers: { authorization: "Bearer test-token-123" },
    });
    executorShouldFail = true;
    const failedExecution = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: "Bearer test-token-123" },
      payload: {
        prompt: "Modify README.md",
        approvalId: jsonWrite3.approvalId,
        operation,
      },
    });
    const failedJson = JSON.parse(failedExecution.payload);
    assert.match(failedJson.error, /Sandbox Executor returned status 500/);
    assert.strictEqual(
      memory.getApproval(jsonWrite3.approvalId)?.status,
      "consumed",
    );
    assert.strictEqual(memory.getTaskStatus(failedJson.taskId), "failed");
  } finally {
    globalThis.fetch = originalFetch;
    memory.db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
