import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";

test("persists provider success, cooldown, reset, and manual pin across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-provider-state-"));
  const now = Date.parse("2026-07-14T16:00:00.000Z");
  let memory = new MemoryStore(dir);

  try {
    memory.providerRuntime.recordFailure({
      provider: "zai_http",
      nodeId: "vps",
      capability: "direct_model",
      failure: {
        kind: "rate_limit",
        retryable: true,
        message: "rate limit",
        cooldownUntil: "2026-07-14T16:02:00.000Z",
      },
      nowMs: now,
    });
    memory.providerRuntime.recordFailure({
      provider: "zai_http",
      nodeId: "vps",
      capability: "direct_model",
      failure: { kind: "timeout", retryable: true, message: "timeout" },
      nowMs: now + 1000,
    });
    memory.providerRuntime.pin("codex_subscription", "vps", "direct_model");

    const limited = memory.providerRuntime.get("zai_http", "vps", "direct_model");
    assert.equal(limited?.status, "cooldown");
    assert.equal(limited?.consecutive_failures, 2);
    assert.equal(limited?.reset_at, "2026-07-14T16:02:00.000Z");
    assert.equal(memory.providerRuntime.getPinned("vps", "direct_model")?.provider, "codex_subscription");

    memory.db.close();
    memory = new MemoryStore(dir, { nowMs: now + 30_000 });
    assert.equal(memory.providerRuntime.get("zai_http", "vps", "direct_model")?.status, "cooldown");
    assert.equal(memory.providerRuntime.getPinned("vps", "direct_model")?.provider, "codex_subscription");

    memory.providerRuntime.clearElapsedCooldowns(now + 180_000);
    assert.equal(memory.providerRuntime.get("zai_http", "vps", "direct_model")?.status, "unknown");

    memory.providerRuntime.recordSuccess({
      provider: "zai_http",
      nodeId: "vps",
      capability: "direct_model",
      latencyMs: 450,
      nowMs: now + 181_000,
    });
    const healthy = memory.providerRuntime.get("zai_http", "vps", "direct_model");
    assert.equal(healthy?.status, "healthy");
    assert.equal(healthy?.consecutive_failures, 0);
    assert.equal(healthy?.last_latency_ms, 450);
    assert.equal(healthy?.last_error_kind, null);
    assert.ok((healthy?.revision ?? 0) >= 4);
  } finally {
    memory.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uses bounded default cooldowns and marks non-retryable failures unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-provider-state-"));
  const memory = new MemoryStore(dir);
  const now = Date.parse("2026-07-14T16:00:00.000Z");
  try {
    memory.providerRuntime.recordFailure({
      provider: "cursor_subscription",
      nodeId: "mac-main",
      capability: "direct_model",
      failure: { kind: "transport", retryable: true, message: "network" },
      nowMs: now,
    });
    const retryable = memory.providerRuntime.get("cursor_subscription", "mac-main", "direct_model");
    assert.equal(retryable?.status, "cooldown");
    assert.equal(retryable?.reset_at, "2026-07-14T16:00:30.000Z");

    memory.providerRuntime.recordFailure({
      provider: "missing_cli",
      nodeId: "vps",
      capability: "coding_cli",
      failure: { kind: "provider_unavailable", retryable: false, message: "missing" },
      nowMs: now,
    });
    assert.equal(memory.providerRuntime.get("missing_cli", "vps", "coding_cli")?.status, "unavailable");
  } finally {
    memory.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
