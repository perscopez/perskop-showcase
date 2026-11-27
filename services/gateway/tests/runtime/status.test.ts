import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { NodeService } from "../../src/tasks/nodeService.js";
import { buildRuntimeStatus } from "../../src/runtime/status.js";
import { claimCronRun, completeCronRun, dailyBriefRunKey, ensureDailyBriefJob } from "../../src/cron/runLease.js";

test("runtime status snapshot includes nodes, connectors, memory, scheduler, and disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-runtime-status-"));
  const memory = new MemoryStore(dir);
  new NodeService(memory).register({
    nodeId: "mac",
    displayName: "MacBook",
    capabilities: ["session_control"],
  });
  const jobId = ensureDailyBriefJob(memory, 13);
  const runKey = dailyBriefRunKey(13, "Europe/Istanbul");
  claimCronRun(memory, { jobId, runKey });
  completeCronRun(memory, runKey, { status: "succeeded", result: "delivered" });
  memory.setLastMailSyncTime("2026-07-21T12:00:00.000Z");
  memory.addMemory({ source: "system", title: "pref", content: "Turkish" });

  const snapshot = buildRuntimeStatus(memory);
  assert.equal(snapshot.nodes.total, 1);
  assert.equal(snapshot.connectors.lastMailSyncAt, "2026-07-21T12:00:00.000Z");
  assert.ok(snapshot.memory.activeCount >= 1);
  assert.equal(snapshot.scheduler.recentRuns[0]?.status, "succeeded");
  assert.ok(["ok", "warning", "critical", "unknown"].includes(snapshot.disk.pressure));

  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
