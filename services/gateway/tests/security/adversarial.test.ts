import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import Fastify from "fastify";
import { registerApiRoutes } from "../../src/api/routes.js";
import { MemoryStore } from "../../src/db.js";
import type { AppConfig } from "../../src/config.js";
import fs from "node:fs";

test("Adversarial Security Tests", async () => {
  const testDir = `./test-security-${crypto.randomBytes(8).toString("hex")}`;
  const config: AppConfig = {
    PORT: 8787,
    HOST: "0.0.0.0",
    DATA_DIR: testDir,
    PERSKOP_API_TOKEN: "secure-api-token",
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
  const operation = {
    schemaVersion: 1,
    repositoryId: "perskop-test",
    workingDirectory: "workspace",
    baseCommit: "a".repeat(40),
    allowedPaths: ["README.md"],
    patch: "+approved\n",
    expectedChangedPaths: ["README.md"],
    engine: "codex",
    timeoutSeconds: 300,
    verificationCommand: ["npm", "test"],
    expectedExitCode: 0,
  };

  try {
    // 1. Expired Scoped Token Check
    const expiredTaskId = memory.addTask({ source: "mac", prompt: "expired-token-test" });
    const expiredToken = memory.issueScopedToken({
      taskId: expiredTaskId,
      executorIdentity: "sandbox-executor",
      scope: "model_proxy",
      expiresInMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const resCompletionsExpired = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${expiredToken}`,
        "x-perskop-task-id": String(expiredTaskId),
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.strictEqual(resCompletionsExpired.statusCode, 401);

    // 2. Unregistered Scoped Token Check
    const resCompletionsUnregistered = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer non-existent-token",
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.strictEqual(resCompletionsUnregistered.statusCode, 401);

    // 3. Forged Approval Re-submission
    // Request a repository write
    const resWrite = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer secure-api-token",
      },
      payload: {
        prompt: "Modify README.md",
        operation,
      },
    });
    const jsonWrite = JSON.parse(resWrite.payload);

    // Verify trying to execute with an unapproved (pending) approvalId fails
    const resClaimPending = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        authorization: "Bearer secure-api-token",
      },
      payload: {
        prompt: "Modify README.md",
        approvalId: jsonWrite.approvalId,
        operation,
      },
    });
    assert.strictEqual(resClaimPending.statusCode, 400);

    // 4. Expiration Claim Failure
    const expiredApprId = crypto.randomUUID();
    const expiredNonce = crypto.randomBytes(16).toString("hex");
    memory.createApproval({
      id: expiredApprId,
      taskId: 1,
      requestedBy: "mac",
      channelId: "api",
      sessionId: "default",
      operationType: "repository_write",
      canonicalPayload: "{}",
      payloadHash: "dummy",
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 1s in past
      nonce: expiredNonce,
    });
    // Set status to approved (but expiresAt is in past!)
    memory.setApprovalStatus(expiredApprId, "approved", "admin");

    const claimExpired = memory.claimApproval(expiredApprId);
    assert.strictEqual(claimExpired, false);

  } finally {
    memory.db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
