import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { claimCronRun, completeCronRun, dailyBriefRunKey, ensureDailyBriefJob, getCronRun } from "../../src/cron/runLease.js";

test("cron run leases are idempotent across restart and expire stale running leases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-cron-lease-"));
  const memory = new MemoryStore(dir);
  const runKey = dailyBriefRunKey(13, "Europe/Istanbul", new Date("2026-07-21T10:00:00.000Z"));
  const jobId = ensureDailyBriefJob(memory, 13);

  const first = claimCronRun(memory, { jobId, runKey, nowMs: Date.parse("2026-07-21T10:00:00.000Z") });
  assert.equal(first.claimed, true);

  const duplicate = claimCronRun(memory, { jobId, runKey, nowMs: Date.parse("2026-07-21T10:01:00.000Z") });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, "lease_held");

  // Simulate process restart while lease still held.
  memory.db.close();
  const restarted = new MemoryStore(dir);
  const stillHeld = claimCronRun(restarted, {
    jobId,
    runKey,
    nowMs: Date.parse("2026-07-21T10:05:00.000Z"),
    leaseMs: 15 * 60_000,
  });
  assert.equal(stillHeld.claimed, false);
  assert.equal(stillHeld.reason, "lease_held");

  const expired = claimCronRun(restarted, {
    jobId,
    runKey,
    nowMs: Date.parse("2026-07-21T10:20:00.000Z"),
    leaseMs: 15 * 60_000,
  });
  assert.equal(expired.claimed, true);

  completeCronRun(restarted, runKey, { status: "succeeded", result: "delivered" });
  const afterSuccess = claimCronRun(restarted, { jobId, runKey, nowMs: Date.parse("2026-07-21T10:21:00.000Z") });
  assert.equal(afterSuccess.claimed, false);
  assert.equal(afterSuccess.reason, "duplicate_run");
  assert.equal(getCronRun(restarted, runKey)?.status, "succeeded");

  restarted.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
