import type { MemoryStore } from "../db.js";
import { NodeService } from "../tasks/nodeService.js";
import { assessDiskPressure, getDiskPressureInfo } from "../storage/diskPressure.js";

export type RuntimeStatusSnapshot = {
  nodes: {
    online: number;
    total: number;
    items: Array<{ id: string; online: boolean; lastHeartbeatAt: string | null; sessionCount: number }>;
  };
  connectors: {
    lastMailSyncAt: string | null;
  };
  memory: {
    countSample: number;
    activeCount: number;
  };
  scheduler: {
    recentRuns: Array<{ run_key: string; status: string; started_at: string; completed_at: string | null }>;
  };
  disk: {
    pressure: string;
    freeMb?: number;
    usedPct?: number;
  };
};

export function buildRuntimeStatus(memory: MemoryStore): RuntimeStatusSnapshot {
  const nodes = new NodeService(memory).listNodes().map((node: any) => ({
    id: String(node.id),
    online: Boolean(node.online),
    lastHeartbeatAt: node.last_heartbeat_at ? String(node.last_heartbeat_at) : null,
    sessionCount: Number(node.session_count || 0),
  }));
  const activeCount = memory.db
    .prepare(`SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND corrected_by_id IS NULL`)
    .get() as { c: number };
  const recentRuns = memory.db
    .prepare(
      `SELECT run_key, status, started_at, completed_at
       FROM cron_runs
       ORDER BY id DESC
       LIMIT 5`,
    )
    .all() as Array<{ run_key: string; status: string; started_at: string; completed_at: string | null }>;

  let disk: RuntimeStatusSnapshot["disk"] = { pressure: "unknown" };
  try {
    const info = getDiskPressureInfo(memory.db.name || ".");
    disk = {
      pressure: assessDiskPressure(info),
      freeMb: Math.round(info.freeBytes / (1024 * 1024)),
      usedPct: info.pct,
    };
  } catch {
    disk = { pressure: "unknown" };
  }

  return {
    nodes: {
      online: nodes.filter((node) => node.online).length,
      total: nodes.length,
      items: nodes.slice(0, 8),
    },
    connectors: {
      lastMailSyncAt: memory.getLastMailSyncTime(),
    },
    memory: {
      countSample: memory.listMemories(1).length,
      activeCount: Number(activeCount?.c || 0),
    },
    scheduler: {
      recentRuns,
    },
    disk,
  };
}
