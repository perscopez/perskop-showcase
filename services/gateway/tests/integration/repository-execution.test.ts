import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import type { AppConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/db.js";
import { routePrompt } from "../../src/providers/router.js";

test("approved repository operation reaches executor unchanged", async () => {
  const dataDir = fs.mkdtempSync("/tmp/perskop-repository-route-");
  const memory = new MemoryStore(dataDir);
  const taskId = memory.addTask({
    source: "mac",
    prompt: "Apply the approved repository patch",
    provider: "codex",
  });
  const patch =
    "diff --git a/README.md b/README.md\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/README.md\n" +
    "+++ b/README.md\n" +
    "@@ -1 +1,2 @@\n" +
    " Perskop\n" +
    "+approved\n";
  const operation = {
    schemaVersion: 1 as const,
    repositoryId: "perskop",
    workingDirectory: "workspace",
    baseCommit: "a".repeat(40),
    allowedPaths: ["README.md"],
    patch,
    expectedChangedPaths: ["README.md"],
    engine: "opencode" as const,
    timeoutSeconds: 123,
    verificationCommand: ["npm", "test"],
    expectedExitCode: 0,
  };
  const config = {
    PORT: 8787,
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    PERSKOP_API_TOKEN: "test",
    DEFAULT_PROVIDER: "codex",
    CODEX_CMD: "codex",
    CURSOR_CMD: "cursor-agent",
    OPENCODE_CMD: "opencode",
    AGY_CMD: "agy",
    EMAIL_IMAP_HOST: "imap.gmail.com",
    EMAIL_IMAP_PORT: 993,
    EMAIL_SMTP_HOST: "smtp.gmail.com",
    EMAIL_SMTP_PORT: 587,
    CRON_EMAIL_ENABLED: false,
    CRON_MORNING_BRIEF: "0 8 * * *",
    CRON_TZ: "Europe/Istanbul",
    PERSKOP_FULL_ACCESS: true,
    allowedTelegramUserIds: [],
    PERSKOP_EXECUTOR_URL: "http://executor",
    PERSKOP_EXECUTOR_TOKEN: "executor-token",
  } satisfies AppConfig;

  let executorPayload: any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    executorPayload = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ exitCode: 0, output: "verified", verification: { ok: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await routePrompt(config, "Apply the approved repository patch", "codex", {
      memory,
      taskId,
      workload: "repository_write",
      approved: true,
      operation,
    });
    assert.equal(executorPayload.profile, "coding");
    assert.equal(executorPayload.provider, "opencode");
    assert.equal(executorPayload.timeoutMs, 123_000);
    assert.equal(executorPayload.workspaceSubdir, `task-${taskId}`);
    assert.deepEqual(executorPayload.operation, {
      ...operation,
      patchHash: crypto.createHash("sha256").update(patch).digest("hex"),
    });
    assert.equal(executorPayload.cmd[0], "/home/node/.local/bin/opencode");
    assert.equal(result.verification?.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    memory.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
