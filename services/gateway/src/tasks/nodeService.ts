import crypto from "node:crypto";
import type { MemoryStore } from "../db.js";
import { TaskService } from "./taskService.js";
import type { TaskStatus } from "./stateMachine.js";

export type NodeCapability = "session_control" | "repository_write" | "chat";

export type AgentSessionInput = {
  sessionId: string;
  source?: string;
  provider?: string | null;
  status?: string;
  title?: string | null;
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class NodeService {
  private readonly tasks: TaskService;

  constructor(private readonly memory: MemoryStore) {
    this.tasks = new TaskService(memory);
    this.ensureSchema();
  }

  private ensureSchema() {
    this.memory.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        app_version TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        token_hash TEXT,
        last_heartbeat_at TEXT,
        online_lease_until TEXT,
        current_load INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_online ON nodes(online_lease_until, revoked_at);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'hermes',
        provider TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        title TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        last_event_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (node_id, session_id),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_recent
        ON agent_sessions(node_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        node_id TEXT,
        event_type TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
    `);

    this.memory.db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_events_no_update
      BEFORE UPDATE ON task_events
      BEGIN
        SELECT RAISE(ABORT, 'task_events are append-only');
      END;
    `);

    const columns = this.memory.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("target_node_id")) {
      this.memory.db.exec("ALTER TABLE tasks ADD COLUMN target_node_id TEXT");
    }
    if (!names.has("parent_session_id")) {
      this.memory.db.exec("ALTER TABLE tasks ADD COLUMN parent_session_id TEXT");
    }
    this.memory.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_target_node ON tasks(target_node_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_session ON tasks(parent_session_id);
    `);
  }

  register(input: {
    nodeId: string;
    displayName: string;
    appVersion?: string | null;
    capabilities?: NodeCapability[];
  }): { nodeId: string; token: string; tokenHash: string } {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    this.memory.db.prepare(`
      INSERT INTO nodes (
        id, display_name, app_version, capabilities_json, token_hash,
        last_heartbeat_at, online_lease_until, current_load, revoked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        app_version = excluded.app_version,
        capabilities_json = excluded.capabilities_json,
        token_hash = excluded.token_hash,
        last_heartbeat_at = excluded.last_heartbeat_at,
        online_lease_until = excluded.online_lease_until,
        revoked_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.nodeId,
      input.displayName,
      input.appVersion ?? null,
      JSON.stringify(input.capabilities ?? []),
      tokenHash,
      now,
      new Date(Date.now() + 90_000).toISOString(),
      now,
    );
    return { nodeId: input.nodeId, token, tokenHash };
  }

  revoke(nodeId: string): void {
    this.memory.db.prepare(`
      UPDATE nodes
      SET revoked_at = datetime('now'), token_hash = NULL, online_lease_until = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(nodeId);
  }

  authenticate(nodeId: string, token: string): boolean {
    const row = this.memory.db.prepare(`
      SELECT token_hash, revoked_at FROM nodes WHERE id = ?
    `).get(nodeId) as { token_hash: string | null; revoked_at: string | null } | undefined;
    if (!row) return false;
    if (row.revoked_at) throw new Error("node_revoked");
    if (!row.token_hash || row.token_hash !== hashToken(token)) throw new Error("node_unauthorized");
    return true;
  }

  heartbeat(input: {
    nodeId: string;
    token: string;
    capabilities?: NodeCapability[];
    currentLoad?: number;
    leaseMs?: number;
    sessions?: AgentSessionInput[];
  }): void {
    this.authenticate(input.nodeId, input.token);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 90_000)).toISOString();
    const write = this.memory.db.transaction(() => {
      this.memory.db.prepare(`
        UPDATE nodes SET
          capabilities_json = ?,
          last_heartbeat_at = ?,
          online_lease_until = ?,
          current_load = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(input.capabilities ?? []),
        now.toISOString(),
        leaseUntil,
        Math.max(0, input.currentLoad ?? 0),
        now.toISOString(),
        input.nodeId,
      );

      this.memory.db.prepare("DELETE FROM agent_sessions WHERE node_id = ?").run(input.nodeId);
      const insert = this.memory.db.prepare(`
        INSERT INTO agent_sessions (
          node_id, session_id, source, provider, status, title, revision, last_event_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const session of (input.sessions ?? []).slice(0, 50)) {
        insert.run(
          input.nodeId,
          session.sessionId,
          session.source ?? "hermes",
          session.provider ?? null,
          session.status ?? "idle",
          session.title ?? null,
          now.toISOString(),
          now.toISOString(),
        );
      }
    });
    write();
  }

  getNode(nodeId: string) {
    return this.memory.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as Record<string, unknown> | undefined;
  }

  listNodes() {
    return this.memory.db.prepare(`
      SELECT n.*,
        CASE WHEN n.revoked_at IS NULL AND n.online_lease_until > datetime('now') THEN 1 ELSE 0 END AS online,
        (SELECT COUNT(*) FROM agent_sessions s WHERE s.node_id = n.id) AS session_count
      FROM nodes n
      ORDER BY n.last_heartbeat_at DESC
    `).all() as Array<Record<string, unknown>>;
  }

  listSessions(nodeId?: string) {
    const clause = nodeId ? "WHERE node_id = ?" : "";
    return this.memory.db.prepare(`
      SELECT * FROM agent_sessions
      ${clause}
      ORDER BY updated_at DESC
      LIMIT 100
    `).all(...(nodeId ? [nodeId] : [])) as Array<Record<string, any>>;
  }

  isOnline(nodeId: string, nowMs = Date.now()): boolean {
    const node = this.getNode(nodeId);
    if (!node || node.revoked_at) return false;
    const lease = Date.parse(String(node.online_lease_until ?? ""));
    return Number.isFinite(lease) && lease > nowMs;
  }

  assignTask(input: { taskId: number; targetNodeId: string; parentSessionId?: string | null }) {
    this.memory.db.prepare(`
      UPDATE tasks
      SET target_node_id = ?, parent_session_id = COALESCE(?, parent_session_id)
      WHERE id = ?
    `).run(input.targetNodeId, input.parentSessionId ?? null, input.taskId);
  }

  appendTaskEvent(input: {
    taskId: number;
    nodeId?: string | null;
    eventType: string;
    revision: number;
    payload?: Record<string, unknown> | null;
  }) {
    this.memory.db.prepare(`
      INSERT INTO task_events (task_id, node_id, event_type, revision, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      input.nodeId ?? null,
      input.eventType,
      input.revision,
      input.payload ? JSON.stringify(input.payload) : null,
    );
  }

  listTaskEvents(taskId: number) {
    return this.memory.db.prepare(`
      SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId) as Array<Record<string, any>>;
  }

  claimTask(input: {
    nodeId: string;
    token: string;
    taskId: number;
    expectedRevision: number;
  }): { ok: true; status: TaskStatus; revision: number } | { ok: false; reason: string; status?: TaskStatus; revision?: number } {
    try {
      this.authenticate(input.nodeId, input.token);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "node_unauthorized" };
    }
    if (!this.isOnline(input.nodeId)) {
      return { ok: false, reason: "node_offline" };
    }

    const row = this.memory.db.prepare(`
      SELECT status, revision, target_node_id FROM tasks WHERE id = ?
    `).get(input.taskId) as { status: TaskStatus; revision: number; target_node_id: string | null } | undefined;
    if (!row) return { ok: false, reason: "task_not_found" };
    if (row.target_node_id && row.target_node_id !== input.nodeId) {
      return { ok: false, reason: "task_not_assigned_to_node", status: row.status, revision: row.revision };
    }

    const claimed = this.memory.db.transaction(() => {
      const transition = this.tasks.transition(input.taskId, {
        to: "running",
        expectedRevision: input.expectedRevision,
      });
      if (!transition.applied) {
        return { ok: false as const, reason: transition.reason, status: transition.status, revision: transition.revision };
      }
      this.appendTaskEvent({
        taskId: input.taskId,
        nodeId: input.nodeId,
        eventType: "claimed",
        revision: transition.revision,
      });
      this.memory.db.prepare("UPDATE nodes SET current_load = current_load + 1, updated_at = datetime('now') WHERE id = ?").run(input.nodeId);
      return { ok: true as const, status: transition.status, revision: transition.revision };
    });
    return claimed();
  }

  listClaimableTasks(nodeId: string) {
    return this.memory.db.prepare(`
      SELECT id, status, revision, prompt, workload, target_node_id, parent_session_id, created_at
      FROM tasks
      WHERE status = 'waiting_for_node'
        AND (target_node_id IS NULL OR target_node_id = ?)
      ORDER BY id ASC
      LIMIT 20
    `).all(nodeId) as Array<Record<string, any>>;
  }
}
