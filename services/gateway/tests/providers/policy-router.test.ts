import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProviderPolicy,
  selectProviderAttempts,
  type PolicyProviderAdapter,
} from "../../src/providers/policyRouter.js";
import type { ProviderRuntimeStateRow } from "../../src/providers/runtimeState.js";

const adapters: PolicyProviderAdapter<string, string>[] = [
  { name: "cursor", capabilities: ["conversation", "repository_write"], highRiskEligible: true, execute: async () => "cursor" },
  { name: "codex", capabilities: ["conversation", "repository_write"], highRiskEligible: true, execute: async () => "codex" },
  { name: "agy", capabilities: ["conversation"], highRiskEligible: false, execute: async () => "agy" },
  { name: "opencode", capabilities: ["conversation"], highRiskEligible: false, execute: async () => "opencode" },
];

function state(provider: string, status: ProviderRuntimeStateRow["status"], resetAt: string | null = null): ProviderRuntimeStateRow {
  return {
    provider,
    node_id: "mac",
    capability: "conversation",
    status,
    consecutive_failures: status === "healthy" ? 0 : 1,
    opened_at: status === "cooldown" ? "2026-07-14T16:00:00.000Z" : null,
    reset_at: resetAt,
    last_success_at: null,
    last_failure_at: null,
    last_latency_ms: null,
    last_error_kind: status === "cooldown" ? "rate_limit" : null,
    manual_pin: 0,
    revision: 1,
    updated_at: "2026-07-14T16:00:00.000Z",
  };
}

test("manual pin wins while capability mismatches and open circuits are diagnosed", () => {
  const result = selectProviderAttempts({
    adapters,
    nodeId: "mac",
    capability: "conversation",
    risk: "low",
    preference: ["cursor", "codex", "agy", "opencode"],
    pinnedProvider: "codex",
    runtimeState: [state("cursor", "cooldown", "2026-07-14T16:10:00.000Z")],
    nowMs: Date.parse("2026-07-14T16:05:00.000Z"),
    maxAttempts: 3,
  });

  assert.deepEqual(result.attempts.map((attempt) => attempt.provider), ["codex", "agy", "opencode"]);
  assert.equal(result.attempts[0]?.reason, "manual_pin");
  assert.ok(result.diagnostics.some((item) => item.provider === "cursor" && item.reason === "cooldown"));

  const mismatch = selectProviderAttempts({
    adapters,
    nodeId: "mac",
    capability: "factual",
    risk: "low",
    preference: ["cursor", "codex"],
  });
  assert.equal(mismatch.attempts.length, 0);
  assert.ok(mismatch.diagnostics.every((item) => item.reason === "capability_mismatch"));
});

test("high-risk work never downgrades and low-risk attempts are bounded and unique", () => {
  const highRisk = selectProviderAttempts({
    adapters,
    nodeId: "mac",
    capability: "repository_write",
    risk: "high",
    preference: ["cursor", "codex", "agy", "opencode"],
    maxAttempts: 4,
  });
  assert.deepEqual(highRisk.attempts.map((attempt) => attempt.provider), ["cursor"]);
  assert.equal(highRisk.attempts[0]?.fallbackAllowed, false);

  const bounded = selectProviderAttempts({
    adapters,
    nodeId: "mac",
    capability: "conversation",
    risk: "low",
    preference: ["cursor", "cursor", "codex", "agy"],
    maxAttempts: 2,
  });
  assert.deepEqual(bounded.attempts.map((attempt) => attempt.provider), ["cursor", "codex"]);
});

test("safe execution falls back once, records reasons, and returns all-provider diagnostics", async () => {
  const traceSnapshots: unknown[] = [];
  const runtimeEvents: string[] = [];
  const result = await executeProviderPolicy({
    adapters: adapters.map((adapter) => ({
      ...adapter,
      execute: adapter.name === "cursor"
        ? async () => { throw Object.assign(new Error("rate limited"), { statusCode: 429, retryAfter: 60 }); }
        : adapter.execute,
    })),
    nodeId: "mac",
    capability: "conversation",
    risk: "low",
    preference: ["cursor", "codex", "agy"],
    maxAttempts: 2,
    runtime: {
      recordFailure: (input) => runtimeEvents.push(`failure:${input.provider}:${input.failure.kind}`),
      recordSuccess: (input) => runtimeEvents.push(`success:${input.provider}`),
    },
    persistTrace: (trace) => traceSnapshots.push(trace),
  });

  assert.equal(result.provider, "codex");
  assert.equal(result.value, "codex");
  assert.deepEqual(runtimeEvents, ["failure:cursor:rate_limit", "success:codex"]);
  assert.equal(result.trace.attempts[1]?.fallbackReason, "cursor:rate_limit");
  assert.ok(traceSnapshots.length >= 2);

  await assert.rejects(
    executeProviderPolicy({
      adapters: adapters.map((adapter) => ({ ...adapter, execute: async () => { throw new Error("offline"); } })),
      nodeId: "mac",
      capability: "conversation",
      risk: "low",
      preference: ["cursor", "codex"],
      maxAttempts: 2,
    }),
    (error: any) => {
      assert.equal(error.code, "ALL_PROVIDERS_UNAVAILABLE");
      assert.equal(error.diagnostics.attempts.length, 2);
      assert.match(error.message, /cursor.*codex/i);
      return true;
    },
  );
});
