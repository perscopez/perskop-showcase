import type { MemoryStore } from "../db.js";

export type CronRunClaim = {
  claimed: boolean;
  runKey: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  reason?: "duplicate_run" | "lease_held";
};

function localDateKey(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function dailyBriefRunKey(hour: number, timeZone: string, now = new Date()): string {
  return `daily-brief:${localDateKey(timeZone, now)}:${hour}`;
}

export function ensureDailyBriefJob(memory: MemoryStore, hour: number): number {
  const name = `daily-brief-${hour}`;
  const existing = memory.db
    .prepare(`SELECT id FROM cron_jobs WHERE name = ? LIMIT 1`)
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  return memory.addCronJob({
    name,
    cron_expr: `0 ${hour} * * *`,
    job_type: "daily_brief",
    enabled: true,
  });
}

export function claimCronRun(
  memory: MemoryStore,
  input: {
    jobId: number;
    runKey: string;
    leaseMs?: number;
    nowMs?: number;
  },
): CronRunClaim {
  const nowMs = input.nowMs ?? Date.now();
  const leaseMs = input.leaseMs ?? 15 * 60_000;
  const startedAt = new Date(nowMs).toISOString();
  const existing = memory.db
    .prepare(`SELECT id, status, started_at, completed_at, result FROM cron_runs WHERE run_key = ?`)
    .get(input.runKey) as
    | { id: number; status: string; started_at: string; completed_at: string | null; result: string | null }
    | undefined;

  if (existing) {
    if (existing.status === "succeeded" || existing.status === "skipped") {
      return { claimed: false, runKey: input.runKey, status: existing.status as CronRunClaim["status"], reason: "duplicate_run" };
    }
    if (existing.status === "running") {
      const startedMs = Date.parse(existing.started_at);
      if (Number.isFinite(startedMs) && nowMs - startedMs < leaseMs) {
        return { claimed: false, runKey: input.runKey, status: "running", reason: "lease_held" };
      }
      memory.db
        .prepare(
          `UPDATE cron_runs
           SET status = 'running', started_at = ?, completed_at = NULL, result = NULL
           WHERE id = ?`,
        )
        .run(startedAt, existing.id);
      return { claimed: true, runKey: input.runKey, status: "running" };
    }
  }

  try {
    memory.db
      .prepare(
        `INSERT INTO cron_runs (cron_job_id, run_key, status, started_at)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(input.jobId, input.runKey, startedAt);
    return { claimed: true, runKey: input.runKey, status: "running" };
  } catch {
    const raced = memory.db
      .prepare(`SELECT status FROM cron_runs WHERE run_key = ?`)
      .get(input.runKey) as { status: string } | undefined;
    return {
      claimed: false,
      runKey: input.runKey,
      status: (raced?.status as CronRunClaim["status"]) || "running",
      reason: "duplicate_run",
    };
  }
}

export function completeCronRun(
  memory: MemoryStore,
  runKey: string,
  input: { status: "succeeded" | "failed" | "skipped"; result?: string },
) {
  memory.db
    .prepare(
      `UPDATE cron_runs
       SET status = ?, completed_at = datetime('now'), result = ?
       WHERE run_key = ?`,
    )
    .run(input.status, input.result ?? null, runKey);
}

export function getCronRun(memory: MemoryStore, runKey: string) {
  return memory.db.prepare(`SELECT * FROM cron_runs WHERE run_key = ?`).get(runKey) as
    | Record<string, unknown>
    | undefined;
}
