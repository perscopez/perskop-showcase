import test from "node:test";
import assert from "node:assert";
import { classifyPrompt, routePrompt } from "../../src/providers/router.js";
import type { AppConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockConfig: AppConfig = {
  PORT: 8787,
  HOST: "0.0.0.0",
  DATA_DIR: "./test-workspace",
  PERSKOP_API_TOKEN: "test-token",
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

test("Workload Classification", () => {
  assert.strictEqual(classifyPrompt("Merhaba, nasılsın?"), "conversation");
  assert.strictEqual(classifyPrompt("Sistem durumu nedir?"), "system_status");
  assert.strictEqual(classifyPrompt("Mail gönder demo@example.com"), "email_write");
  assert.strictEqual(classifyPrompt("son mailleri göster"), "email_read");
  assert.strictEqual(classifyPrompt("Modify README.md to add details"), "repository_write");
  assert.strictEqual(classifyPrompt("run command npm test"), "shell_action");
  assert.strictEqual(classifyPrompt("Türkiye başkenti nedir? Yalnızca şehri yaz."), "factual");
});

test("Route Prompt - Direct Model & Deterministic Tools", async () => {
  const originalFetch = globalThis.fetch;
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-routing-"));
  const memory = new MemoryStore(testDir);

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
    // 1. Direct Model greeting
    const res1 = await routePrompt(mockConfig, "Merhaba");
    assert.strictEqual(res1.provider, "direct_model");
    assert.ok(res1.output.includes("Mocked direct model response"));

    // 2. Deterministic tool system status
    const res2 = await routePrompt(mockConfig, "Sistem durumunu göster");
    assert.strictEqual(res2.provider, "deterministic_tool");
    assert.ok(res2.output.includes("System Status"));

    // 3. Coding CLI repository write (requires taskId)
    const taskId = memory.addTask({ source: "mac", prompt: "Modify README.md to add lines" });
    const res3 = await routePrompt(mockConfig, "Modify README.md to add lines", undefined, {
      taskId,
      memory,
      operation: {
        schemaVersion: 1,
        repositoryId: "perskop",
        workingDirectory: "workspace",
        baseCommit: "a".repeat(40),
        allowedPaths: ["README.md"],
        patch: "diff --git a/README.md b/README.md\n+approved\n",
        expectedChangedPaths: ["README.md"],
        engine: "codex",
        timeoutSeconds: 300,
        verificationCommand: ["npm", "test"],
        expectedExitCode: 0,
      },
    });
    assert.strictEqual(res3.provider, "coding_cli");
    assert.ok(res3.output.includes("Mocked sandbox execution"));
  } finally {
    globalThis.fetch = originalFetch;
    memory.db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("conversation routing persists a bounded fallback trace and provider cooldown", async () => {
  const originalFetch = globalThis.fetch;
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-policy-route-"));
  const memory = new MemoryStore(testDir);
  const fallbackCli = path.join(testDir, "fallback-codex.sh");
  fs.writeFileSync(fallbackCli, "#!/bin/sh\nprintf 'fallback provider response'\n", { mode: 0o755 });
  const config: AppConfig = {
    ...mockConfig,
    DATA_DIR: testDir,
    CODEX_CMD: fallbackCli,
    PERSKOP_NODE_ID: "vps",
    PERSKOP_VPS_PROVIDER_ORDER: "direct_model,codex,agy",
    PERSKOP_PROVIDER_MAX_ATTEMPTS: 2,
  };
  globalThis.fetch = (async () => new Response("quota", {
    status: 429,
    headers: { "Retry-After": "60" },
  })) as typeof fetch;

  try {
    const taskId = memory.addTask({ source: "mac", prompt: "Türkiye başkenti nedir?" });
    const result = await routePrompt(config, "Türkiye başkenti nedir?", undefined, { memory, taskId });
    assert.equal(result.provider, "codex");
    assert.match(result.output, /fallback provider response/);

    const directState = memory.providerRuntime.get("direct_model", "vps", "factual");
    assert.equal(directState?.status, "cooldown");
    assert.equal(directState?.last_error_kind, "rate_limit");

    const row = memory.db.prepare("SELECT routing_trace FROM tasks WHERE id = ?").get(taskId) as { routing_trace: string };
    const trace = JSON.parse(row.routing_trace);
    assert.deepEqual(trace.attempts.map((attempt: any) => attempt.provider), ["direct_model", "codex"]);
    assert.equal(trace.attempts[1].fallbackReason, "direct_model:rate_limit");
  } finally {
    globalThis.fetch = originalFetch;
    memory.db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
