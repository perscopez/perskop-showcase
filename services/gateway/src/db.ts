import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PROVIDER_NAMES,
  type ProviderName,
} from "./providers/router.js";
import {
  assessDiskPressure,
  getDiskPressureInfo,
} from "./storage/diskPressure.js";
import { ProviderRuntimeStateRepository } from "./providers/runtimeState.js";
import { TaskService, type TaskTransitionFields } from "./tasks/taskService.js";
import type { TaskStatus } from "./tasks/stateMachine.js";

export type MemorySource = "telegram" | "mac" | "system";

export type MemoryRow = {
  id: number;
  source: MemorySource;
  user_id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  provider: string | null;
  created_at: string;
  expires_at: string | null;
  confidence?: number;
  sensitivity?: string;
  provenance_json?: string | null;
  revision?: number;
  pinned?: number;
  deleted_at?: string | null;
  corrected_by_id?: number | null;
  corrects_id?: number | null;
  retention_days?: number | null;
  dedupe_key?: string | null;
};

export type ApprovalRow = {
  id: string;
  task_id: number;
  requested_by: string;
  approved_by: string | null;
  channel_id: string;
  session_id: string;
  operation_type: string;
  canonical_payload: string;
  payload_hash: string;
  status: "pending" | "approved" | "claimed" | "consumed" | "expired";
  created_at: string;
  approved_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  nonce: string;
  version: number;
};

export type ScopedTokenStatus = "active" | "consumed" | "revoked" | "expired";

export type ScopedTokenRow = {
  token_hash: string;
  task_id: number;
  executor_identity: string;
  scope: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  status: ScopedTokenStatus;
};

export class MemoryStore {
  public db!: Database.Database;
  public providerRuntime!: ProviderRuntimeStateRepository;

  constructor(dataDir: string, options: { nowMs?: number } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "perskop.db");

    try {
      const pressure = getDiskPressureInfo(dataDir);
      const level = assessDiskPressure(pressure);
      if (level !== "ok") {
        console.warn(
          `[Database] ${level.toUpperCase()}: disk is ${pressure.pct}% used ` +
            `(${Math.round(pressure.freeBytes / 1024 / 1024)} MB free).`,
        );
      }
    } catch (error) {
      console.warn(`[Database] Disk pressure could not be measured: ${String(error)}`);
    }

    // Startup is deliberately non-recovering. If WAL cannot be opened, fail
    // closed and require the explicit writer-stopped recovery command.
    this.db = new Database(dbPath, { timeout: 5000 });
    try {
      this.db.pragma("journal_mode = WAL");
      const integrity = this.db.pragma("quick_check") as Array<{ quick_check: string }>;
      if (integrity[0]?.quick_check !== "ok") {
        throw new Error(`SQLite quick_check failed: ${JSON.stringify(integrity)}`);
      }
    } catch (error) {
      this.db.close();
      throw new Error(
        `SQLite startup verification failed; automatic WAL/SHM deletion and journal fallback are disabled. ` +
          `Stop writers and run explicit recovery. Cause: ${String(error)}`,
      );
    }

    this.init();
    this.providerRuntime = new ProviderRuntimeStateRepository(this.db);
    this.providerRuntime.clearElapsedCooldowns(options.nowMs ?? Date.now());
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'owner',
        project_id TEXT NOT NULL DEFAULT 'global',
        memory_type TEXT NOT NULL DEFAULT 'note',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        provider TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title,
        content,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO memories_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        provider TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        job_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cron_job_id INTEGER NOT NULL,
        run_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        result TEXT,
        FOREIGN KEY (cron_job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(cron_job_id);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_key ON cron_runs(run_key);

      CREATE TABLE IF NOT EXISTS emails (
        uid TEXT PRIMARY KEY,
        msg_index INTEGER NOT NULL,
        subject TEXT NOT NULL,
        from_address TEXT NOT NULL,
        date TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        body_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_uid TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        text_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (email_uid) REFERENCES emails(uid) ON DELETE CASCADE
      );
    `);

    const memoryColumns = this.db.prepare("PRAGMA table_info(memories)").all() as any[];
    const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
    const memoryMigrations: Record<string, string> = {
      user_id: "TEXT NOT NULL DEFAULT 'owner'",
      project_id: "TEXT NOT NULL DEFAULT 'global'",
      memory_type: "TEXT NOT NULL DEFAULT 'note'",
      expires_at: "TEXT",
      confidence: "REAL NOT NULL DEFAULT 0.5",
      sensitivity: "TEXT NOT NULL DEFAULT 'personal'",
      provenance_json: "TEXT",
      revision: "INTEGER NOT NULL DEFAULT 1",
      pinned: "INTEGER NOT NULL DEFAULT 0",
      deleted_at: "TEXT",
      corrected_by_id: "INTEGER",
      corrects_id: "INTEGER",
      retention_days: "INTEGER",
      dedupe_key: "TEXT",
    };
    for (const [column, definition] of Object.entries(memoryMigrations)) {
      if (!memoryColumnNames.has(column)) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${column} ${definition}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(user_id, project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_expiry
        ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS idx_memories_dedupe
        ON memories(user_id, project_id, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned
        ON memories(pinned, deleted_at);
    `);

    // Migration 002: Hardened Approvals Schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        requested_by TEXT NOT NULL,
        approved_by TEXT,
        channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        nonce TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `);

    // Migration 003: Persistent Scoped Tokens (P2)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scoped_tokens (
        token_hash TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        executor_identity TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'model_proxy',
        issued_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_scoped_tokens_task ON scoped_tokens(task_id);
      CREATE INDEX IF NOT EXISTS idx_scoped_tokens_status ON scoped_tokens(status);
    `);

    // Migration 004: persistent provider health, cooldown, and user pin state.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_runtime_state (
        provider TEXT NOT NULL,
        node_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT,
        reset_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_latency_ms INTEGER,
        last_error_kind TEXT,
        manual_pin INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (provider, node_id, capability)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_runtime_selection
        ON provider_runtime_state(node_id, capability, status, reset_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_runtime_single_pin
        ON provider_runtime_state(node_id, capability)
        WHERE manual_pin = 1;
    `);

    // Migration 005: calendar connector registry. Source event data is scoped to
    // its owning account and connector credentials live in a separate encrypted table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        source TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connected',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_connector_accounts_owner ON connector_accounts(owner_id, source);

      CREATE TABLE IF NOT EXISTS connector_secrets (
        account_id TEXT NOT NULL,
        secret_kind TEXT NOT NULL,
        key_id TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, secret_kind),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calendar_calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_calendar_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        capabilities_json TEXT NOT NULL,
        source_version TEXT,
        freshness TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, source_calendar_id),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_version TEXT,
        event_json TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        freshness TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(calendar_id, source_event_id),
        FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(calendar_id, starts_at, ends_at);

      CREATE TABLE IF NOT EXISTS calendar_sync_state (
        account_id TEXT NOT NULL,
        calendar_id TEXT,
        cursor TEXT,
        last_success_at TEXT,
        last_error TEXT,
        freshness TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (account_id, calendar_id),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calendar_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        source_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calendar_idempotency (
        account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, idempotency_key),
        FOREIGN KEY (operation_id) REFERENCES calendar_operations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS oauth_pending_states (
        state_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        verifier_ciphertext BLOB NOT NULL,
        verifier_nonce BLOB NOT NULL,
        verifier_auth_tag BLOB NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_pending_expiry ON oauth_pending_states(expires_at);
    `);
    // Mark elapsed active tokens on startup. Revoked/expired records are retained
    // as audit evidence rather than silently resurrected or deleted.
    this.pruneExpiredTokens();

    // Migration: tasks extra columns
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as any[];
    const columnNames = columns.map((c) => c.name);

    const newCols = {
      workload: "TEXT",
      engine: "TEXT",
      proposed_operation: "TEXT",
      approval_id: "TEXT",
      expected_outcome: "TEXT",
      deadline: "TEXT",
      cancellation_state: "TEXT DEFAULT 'active'",
      verification_result: "TEXT",
      structured_error: "TEXT",
      routing_trace: "TEXT",
      revision: "INTEGER NOT NULL DEFAULT 1",
    };

    for (const [col, type] of Object.entries(newCols)) {
      if (!columnNames.includes(col)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
      }
    }
  }

  getCloudProvider(): ProviderName | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'cloud_provider'`)
      .get() as { value: string } | undefined;
    if (row?.value && PROVIDER_NAMES.includes(row.value as ProviderName)) {
      return row.value as ProviderName;
    }
    return null;
  }

  setCloudProvider(provider: ProviderName) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('cloud_provider', @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ value: provider });
  }

  getMailFocus(chatKey: string): number | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(`mail_focus:${chatKey}`) as { value: string } | undefined;
    if (!row?.value) return null;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  setMailFocus(chatKey: string, index: number) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ key: `mail_focus:${chatKey}`, value: String(index) });
  }

  addMemory(input: {
    source: MemorySource;
    userId?: string;
    projectId?: string;
    memoryType?: string;
    title: string;
    content: string;
    provider?: string | null;
    expiresAt?: string | null;
  }): MemoryRow {
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        source, user_id, project_id, memory_type, title, content, provider, expires_at
      )
      VALUES (
        @source, @userId, @projectId, @memoryType, @title, @content, @provider, @expiresAt
      )
    `);
    const info = stmt.run({
      source: input.source,
      userId: input.userId ?? "owner",
      projectId: input.projectId ?? "global",
      memoryType: input.memoryType ?? "note",
      title: input.title,
      content: input.content,
      provider: input.provider ?? null,
      expiresAt: input.expiresAt ?? null,
    });
    return this.getMemory(Number(info.lastInsertRowid))!;
  }

  getMemory(id: number): MemoryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as MemoryRow | undefined;
  }

  listMemories(limit = 20): MemoryRow[] {
    return this.db
      .prepare(`SELECT * FROM memories ORDER BY id DESC LIMIT ?`)
      .all(limit) as MemoryRow[];
  }

  searchMemories(query: string, limit = 20): MemoryRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM memories_fts f
        JOIN memories m ON m.id = f.rowid
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(query, limit) as MemoryRow[];
    return rows;
  }

  retrieveScopedMemories(input: {
    userId: string;
    projectId: string;
    query?: string;
    memoryType?: string;
    limit?: number;
    now?: string;
  }): MemoryRow[] {
    const now = input.now ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const params = {
      userId: input.userId,
      projectId: input.projectId,
      memoryType: input.memoryType ?? null,
      now,
      limit,
    };
    if (!input.query?.trim()) {
      return this.db
        .prepare(
          `SELECT * FROM memories
           WHERE user_id = @userId
             AND (project_id = @projectId OR project_id = 'global')
             AND (@memoryType IS NULL OR memory_type = @memoryType)
             AND (expires_at IS NULL OR expires_at > @now)
           ORDER BY CASE WHEN project_id = @projectId THEN 0 ELSE 1 END, created_at DESC, id DESC
           LIMIT @limit`,
        )
        .all(params) as MemoryRow[];
    }

    const ftsQuery = input.query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" AND ");
    if (!ftsQuery) return [];
    return this.db
      .prepare(
        `SELECT m.*
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH @query
           AND m.user_id = @userId
           AND (m.project_id = @projectId OR m.project_id = 'global')
           AND (@memoryType IS NULL OR m.memory_type = @memoryType)
           AND (m.expires_at IS NULL OR m.expires_at > @now)
         ORDER BY CASE WHEN m.project_id = @projectId THEN 0 ELSE 1 END, rank, m.created_at DESC
         LIMIT @limit`,
      )
      .all({ ...params, query: ftsQuery }) as MemoryRow[];
  }

  addTask(input: {
    source: MemorySource;
    prompt: string;
    provider?: string | null;
    workload?: string | null;
    engine?: string | null;
    proposed_operation?: string | null;
    approval_id?: string | null;
    expected_outcome?: string | null;
    deadline?: string | null;
    status?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        source, prompt, provider, status,
        workload, engine, proposed_operation, approval_id, expected_outcome, deadline
      )
      VALUES (
        @source, @prompt, @provider, @status,
        @workload, @engine, @proposed_operation, @approval_id, @expected_outcome, @deadline
      )
    `);
    const info = stmt.run({
      source: input.source,
      prompt: input.prompt,
      provider: input.provider ?? null,
      status: input.status ?? "running",
      workload: input.workload ?? null,
      engine: input.engine ?? null,
      proposed_operation: input.proposed_operation ?? null,
      approval_id: input.approval_id ?? null,
      expected_outcome: input.expected_outcome ?? null,
      deadline: input.deadline ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  completeTask(
    id: number,
    input: { response: string; provider: string },
  ) {
    const current = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(id) as { revision: number } | undefined;
    if (!current) return;
    return new TaskService(this).transition(id, {
      to: "done",
      expectedRevision: current.revision,
      fields: input,
    });
  }

  failTask(id: number, error: string) {
    const current = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(id) as { revision: number } | undefined;
    if (!current) return;
    return new TaskService(this).transition(id, {
      to: "error",
      expectedRevision: current.revision,
      fields: { error },
    });
  }

  updateTask(
    id: number,
    fields: {
      status?: string;
      response?: string;
      provider?: string;
      error?: string;
      workload?: string;
      engine?: string;
      proposed_operation?: string;
      approval_id?: string;
      expected_outcome?: string;
      deadline?: string;
      cancellation_state?: string;
      verification_result?: string;
      structured_error?: string;
      routing_trace?: string;
    },
  ) {
    if (fields.status !== undefined) {
      const current = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(id) as { revision: number } | undefined;
      if (!current) return;
      const { status, ...rest } = fields;
      return new TaskService(this).transition(id, {
        to: status as TaskStatus,
        expectedRevision: current.revision,
        fields: rest as TaskTransitionFields,
      });
    }

    const sets: string[] = [];
    const params: Record<string, any> = { id };

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = value;
      }
    }

    if (
      fields.status === "succeeded" ||
      fields.status === "failed" ||
      fields.status === "done" ||
      fields.status === "error"
    ) {
      sets.push("completed_at = datetime('now')");
    }

    if (sets.length === 0) return;

    this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);

    if (["succeeded", "failed", "done", "error", "timed_out", "cancelled", "rejected"].includes(fields.status ?? "")) {
      this.revokeScopedTokensByTask(id);
    }
  }

  getTaskStatus(id: number): string | undefined {
    return (this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status?: string } | undefined)?.status;
  }

  createApproval(input: {
    id: string;
    taskId: number;
    requestedBy: string;
    channelId: string;
    sessionId: string;
    operationType: string;
    canonicalPayload: string;
    payloadHash: string;
    expiresAt: string;
    nonce: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, task_id, requested_by, channel_id, session_id, operation_type, canonical_payload, payload_hash, expires_at, nonce, status)
      VALUES (@id, @taskId, @requestedBy, @channelId, @sessionId, @operationType, @canonicalPayload, @payloadHash, @expiresAt, @nonce, 'pending')
    `);
    stmt.run(input);
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(id) as ApprovalRow | undefined;
  }

  getApprovalByTask(taskId: number): ApprovalRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as ApprovalRow | undefined;
  }

  claimApproval(id: string, nowStr: string = new Date().toISOString()): boolean {
    const info = this.db
      .prepare(
        `
        UPDATE approvals
        SET status = 'claimed'
        WHERE id = ?
          AND status = 'approved'
          AND expires_at > ?
      `,
      )
      .run(id, nowStr);
    return info.changes === 1;
  }

  setApprovalStatus(
    id: string,
    status: "pending" | "approved" | "claimed" | "consumed" | "expired",
    approvedBy?: string,
  ) {
    if (approvedBy && status === "approved") {
      this.db
        .prepare(
          `
          UPDATE approvals
          SET status = ?, approved_by = ?, approved_at = ?
          WHERE id = ?
        `,
        )
        .run(status, approvedBy, new Date().toISOString(), id);
    } else if (status === "consumed") {
      this.db
        .prepare(
          `
          UPDATE approvals
          SET status = ?, consumed_at = ?
          WHERE id = ?
        `,
        )
        .run(status, new Date().toISOString(), id);
    } else {
      this.db
        .prepare(
          `
          UPDATE approvals
          SET status = ?
          WHERE id = ?
        `,
        )
        .run(status, id);
    }
  }

  expireStaleApprovals(nowStr: string = new Date().toISOString()) {
    this.db
      .prepare(
        `
        UPDATE approvals
        SET status = 'expired'
        WHERE status IN ('pending', 'approved')
          AND expires_at <= ?
      `,
      )
      .run(nowStr);
  }

  listTasks(limit = 20) {
    return this.db
      .prepare(`SELECT * FROM tasks ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }

  saveEmail(email: {
    uid: string;
    msg_index: number;
    subject: string;
    from_address: string;
    date: string;
    seen: boolean;
    body_text: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO emails (uid, msg_index, subject, from_address, date, seen, body_text)
      VALUES (@uid, @msg_index, @subject, @from_address, @date, @seen, @body_text)
      ON CONFLICT(uid) DO UPDATE SET
        msg_index = excluded.msg_index,
        subject = excluded.subject,
        from_address = excluded.from_address,
        date = excluded.date,
        seen = excluded.seen,
        body_text = excluded.body_text
    `);
    stmt.run({
      uid: email.uid,
      msg_index: email.msg_index,
      subject: email.subject,
      from_address: email.from_address,
      date: email.date,
      seen: email.seen ? 1 : 0,
      body_text: email.body_text,
    });
  }

  getEmails(limit = 15): Array<{
    uid: string;
    msg_index: number;
    subject: string;
    from_address: string;
    date: string;
    seen: number;
    body_text: string;
  }> {
    return this.db
      .prepare(`SELECT * FROM emails ORDER BY msg_index ASC LIMIT ?`)
      .all(limit) as any[];
  }

  saveAttachment(att: {
    email_uid: string;
    filename: string;
    content_type: string;
    size: number;
    path: string;
    text_path?: string | null;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO attachments (email_uid, filename, content_type, size, path, text_path)
      VALUES (@email_uid, @filename, @content_type, @size, @path, @text_path)
    `);
    stmt.run({
      email_uid: att.email_uid,
      filename: att.filename,
      content_type: att.content_type,
      size: att.size,
      path: att.path,
      text_path: att.text_path || null,
    });
  }

  getEmailAttachments(email_uid: string): Array<{
    filename: string;
    content_type: string;
    size: number;
    path: string;
    text_path: string | null;
  }> {
    return this.db
      .prepare(`SELECT filename, content_type, size, path, text_path FROM attachments WHERE email_uid = ?`)
      .all(email_uid) as any[];
  }

  getLastMailSyncTime(): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'last_mail_sync_at'`)
      .get() as { value: string } | undefined;
    return row?.value || null;
  }

  setLastMailSyncTime(time: string) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('last_mail_sync_at', @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ value: time });
  }

  // --- Cron job management ---

  addCronJob(input: {
    name: string;
    cron_expr: string;
    job_type: string;
    enabled?: boolean;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO cron_jobs (name, cron_expr, job_type, enabled)
      VALUES (@name, @cron_expr, @job_type, @enabled)
    `);
    const info = stmt.run({
      name: input.name,
      cron_expr: input.cron_expr,
      job_type: input.job_type,
      enabled: input.enabled !== false ? 1 : 0,
    });
    return Number(info.lastInsertRowid);
  }

  listCronJobs() {
    return this.db
      .prepare(`SELECT * FROM cron_jobs ORDER BY id ASC`)
      .all();
  }

  getCronJob(id: number) {
    return this.db
      .prepare(`SELECT * FROM cron_jobs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
  }

  updateCronJob(
    id: number,
    input: {
      name?: string;
      cron_expr?: string;
      job_type?: string;
      enabled?: boolean;
    },
  ) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.name !== undefined) {
      sets.push("name = @name");
      params.name = input.name;
    }
    if (input.cron_expr !== undefined) {
      sets.push("cron_expr = @cron_expr");
      params.cron_expr = input.cron_expr;
    }
    if (input.job_type !== undefined) {
      sets.push("job_type = @job_type");
      params.job_type = input.job_type;
    }
    if (input.enabled !== undefined) {
      sets.push("enabled = @enabled");
      params.enabled = input.enabled ? 1 : 0;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  }

  markCronJobRun(id: number, result: string) {
    this.db
      .prepare(
        `UPDATE cron_jobs SET last_run_at = datetime('now'), last_result = @result WHERE id = @id`,
      )
      .run({ id, result });
  }

  deleteCronJob(id: number) {
    this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  }

  getEnabledCronJobs() {
    return this.db
      .prepare(
        `SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY id ASC`,
      )
      .all() as Array<{
        id: number;
        name: string;
        cron_expr: string;
        job_type: string;
      }>;
  }

  listPendingApprovals(): ApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ?`)
      .all(new Date().toISOString()) as ApprovalRow[];
  }

  // ---------------------------------------------------------------------------
  // P2: Scoped Token Management
  // Plaintext tokens are NEVER stored. Only SHA-256 hashes are persisted.
  // ---------------------------------------------------------------------------

  /**
   * Hash a plaintext token for storage/lookup.
   * The caller holds the plaintext; only this hash goes into the DB.
   */
  static hashToken(plaintext: string): string {
    return crypto.createHash("sha256").update(plaintext).digest("hex");
  }

  /**
   * Issue a new scoped token. Returns the plaintext token (once only).
   * Caller must store and transmit it securely; only the hash is persisted.
   */
  issueScopedToken(input: {
    taskId: number;
    executorIdentity: string;
    scope?: string;
    expiresInMs?: number;
  }): string {
    const plaintext = `scoped-${crypto.randomUUID()}`;
    const hash = MemoryStore.hashToken(plaintext);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.expiresInMs ?? 5 * 60 * 1000)).toISOString();
    this.db
      .prepare(
        `INSERT INTO scoped_tokens (token_hash, task_id, executor_identity, scope, issued_at, expires_at, status)
         VALUES (@token_hash, @task_id, @executor_identity, @scope, @issued_at, @expires_at, 'active')`,
      )
      .run({
        token_hash: hash,
        task_id: input.taskId,
        executor_identity: input.executorIdentity,
        scope: input.scope ?? "model_proxy",
        issued_at: now.toISOString(),
        expires_at: expiresAt,
      });
    return plaintext;
  }

  /**
   * Validate a scoped token. Checks: active status, not expired, correct executor.
   * Does NOT consume the token.
   */
  validateScopedToken(
    plaintext: string,
    executorIdentity: string,
    expected?: { taskId?: number; scope?: string },
  ): { taskId: number; scope: string } | null {
    const hash = MemoryStore.hashToken(plaintext);
    const row = this.db
      .prepare(
        `SELECT task_id, scope FROM scoped_tokens
         WHERE token_hash = @token_hash
           AND executor_identity = @executor_identity
           AND status = 'active'
           AND expires_at > @now
           AND (@task_id IS NULL OR task_id = @task_id)
           AND (@scope IS NULL OR scope = @scope)`,
      )
      .get({
        token_hash: hash,
        executor_identity: executorIdentity,
        now: new Date().toISOString(),
        task_id: expected?.taskId ?? null,
        scope: expected?.scope ?? null,
      }) as
      | { task_id: number; scope: string }
      | undefined;
    return row ? { taskId: row.task_id, scope: row.scope } : null;
  }

  /**
   * Atomically consume a scoped token (single-use semantics).
   * Returns true only if the token was active and is now consumed.
   */
  consumeScopedToken(
    plaintext: string,
    executorIdentity: string,
    expected?: { taskId?: number; scope?: string },
  ): { taskId: number; scope: string } | null {
    const hash = MemoryStore.hashToken(plaintext);
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE scoped_tokens
         SET status = 'consumed', consumed_at = @now
         WHERE token_hash = @token_hash
           AND executor_identity = @executor_identity
           AND status = 'active'
           AND expires_at > @now
           AND (@task_id IS NULL OR task_id = @task_id)
           AND (@scope IS NULL OR scope = @scope)
         RETURNING task_id, scope`,
      )
      .get({
        now,
        token_hash: hash,
        executor_identity: executorIdentity,
        task_id: expected?.taskId ?? null,
        scope: expected?.scope ?? null,
      }) as { task_id: number; scope: string } | undefined;
    return row ? { taskId: row.task_id, scope: row.scope } : null;
  }

  /**
   * Revoke all active tokens for a given task.
   * Called on task cancellation, timeout, or completion.
   */
  revokeScopedTokensByTask(taskId: number): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE scoped_tokens
         SET status = 'revoked', revoked_at = ?
         WHERE task_id = ? AND status = 'active'`,
      )
      .run(now, taskId);
    return info.changes;
  }

  /**
   * Mark elapsed active tokens as expired while retaining audit history.
   */
  pruneExpiredTokens(): number {
    const info = this.db
      .prepare(
        `UPDATE scoped_tokens
         SET status = 'expired'
         WHERE status = 'active' AND expires_at <= ?`,
      )
      .run(new Date().toISOString());
    return info.changes;
  }

  getScopedToken(plaintext: string): ScopedTokenRow | undefined {
    const hash = MemoryStore.hashToken(plaintext);
    return this.db
      .prepare(`SELECT * FROM scoped_tokens WHERE token_hash = ?`)
      .get(hash) as ScopedTokenRow | undefined;
  }
}
