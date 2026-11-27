import crypto from "node:crypto";
import type Database from "better-sqlite3";

export type RemoteSessionSummary = {
  id: string;
  title: string | null;
  preview: string | null;
  cwd: string | null;
  profile: string | null;
  isActive: boolean;
  lastActive: number;
};

export type RemoteCommandAction = "focus_session" | "new_session" | "read_session" | "send_prompt";

export class RemoteSessionStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_nodes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        app_version TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS remote_sessions (
        node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        preview TEXT,
        cwd TEXT,
        profile TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (node_id, session_id),
        FOREIGN KEY (node_id) REFERENCES remote_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_remote_sessions_recent
        ON remote_sessions(node_id, last_active DESC);
      CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (node_id) REFERENCES remote_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_remote_commands_pending
        ON remote_commands(node_id, status, created_at);
    `);
  }

  heartbeat(input: {
    nodeId: string;
    displayName: string;
    appVersion?: string | null;
    sessions: RemoteSessionSummary[];
  }): void {
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO remote_nodes (id, display_name, app_version, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          app_version = excluded.app_version,
          last_seen_at = excluded.last_seen_at
      `).run(input.nodeId, input.displayName, input.appVersion ?? null, now);

      this.db.prepare("DELETE FROM remote_sessions WHERE node_id = ?").run(input.nodeId);
      const insert = this.db.prepare(`
        INSERT INTO remote_sessions (
          node_id, session_id, title, preview, cwd, profile, is_active, last_active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const session of input.sessions.slice(0, 50)) {
        insert.run(
          input.nodeId,
          session.id,
          session.title,
          session.preview,
          session.cwd,
          session.profile,
          session.isActive ? 1 : 0,
          session.lastActive,
          now,
        );
      }
    });
    write();
    this.pruneCommands();
  }

  listNodes(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT n.*, COUNT(s.session_id) AS session_count
      FROM remote_nodes n
      LEFT JOIN remote_sessions s ON s.node_id = n.id
      GROUP BY n.id
      ORDER BY n.last_seen_at DESC
    `).all() as Array<Record<string, unknown>>;
  }

  listSessions(nodeId?: string): Array<Record<string, unknown>> {
    const clause = nodeId ? "WHERE s.node_id = ?" : "";
    return this.db.prepare(`
      SELECT s.*, n.display_name, n.last_seen_at
      FROM remote_sessions s
      JOIN remote_nodes n ON n.id = s.node_id
      ${clause}
      ORDER BY s.is_active DESC, s.last_active DESC
      LIMIT 50
    `).all(...(nodeId ? [nodeId] : [])) as Array<Record<string, unknown>>;
  }

  findSession(prefix: string): Record<string, any> | null {
    const normalized = prefix.trim();
    if (!normalized) return null;
    const rows = this.db.prepare(`
      SELECT s.*, n.display_name, n.last_seen_at
      FROM remote_sessions s
      JOIN remote_nodes n ON n.id = s.node_id
      WHERE s.session_id = ? OR s.session_id LIKE ? OR s.session_id LIKE ?
      ORDER BY CASE WHEN s.session_id = ? THEN 0 ELSE 1 END, s.last_active DESC
      LIMIT 2
    `).all(normalized, `${normalized}%`, `%${normalized}`, normalized) as Array<Record<string, any>>;
    return rows.length === 1 || rows[0]?.session_id === normalized ? rows[0] : null;
  }

  queueCommand(input: { nodeId: string; action: RemoteCommandAction; sessionId?: string | null }): Record<string, any> {
    if (input.action !== "send_prompt") {
      const existing = this.db.prepare(`
        SELECT * FROM remote_commands
        WHERE node_id = ? AND action = ? AND COALESCE(session_id, '') = COALESCE(?, '')
          AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.nodeId, input.action, input.sessionId ?? null, new Date().toISOString()) as Record<string, any> | undefined;
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    this.db.prepare(`
      INSERT INTO remote_commands (id, node_id, action, session_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.nodeId, input.action, input.sessionId ?? null, now.toISOString(), expiresAt);
    return this.db.prepare("SELECT * FROM remote_commands WHERE id = ?").get(id) as Record<string, any>;
  }

  listPendingCommands(nodeId: string): Array<Record<string, any>> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE remote_commands SET status = 'expired', completed_at = ?
      WHERE node_id = ? AND status = 'pending' AND expires_at <= ?
    `).run(now, nodeId, now);
    return this.db.prepare(`
      SELECT * FROM remote_commands
      WHERE node_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at ASC
      LIMIT 20
    `).all(nodeId, now) as Array<Record<string, any>>;
  }

  completeCommand(id: string, nodeId: string, ok: boolean, error?: string | null): boolean {
    const info = this.db.prepare(`
      UPDATE remote_commands
      SET status = ?, completed_at = ?, error = ?
      WHERE id = ? AND node_id = ? AND status = 'pending'
    `).run(ok ? "completed" : "failed", new Date().toISOString(), error ?? null, id, nodeId);
    return info.changes === 1;
  }

  pruneCommands(nowMs = Date.now()): number {
    const now = new Date(nowMs).toISOString();
    const cutoff = new Date(nowMs - 7 * 24 * 60 * 60_000).toISOString();
    this.db.prepare(`
      UPDATE remote_commands SET status = 'expired', completed_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
    return this.db.prepare(`
      DELETE FROM remote_commands
      WHERE status IN ('completed', 'failed', 'expired')
        AND julianday(COALESCE(completed_at, expires_at)) <= julianday(?)
    `).run(cutoff).changes;
  }
}
