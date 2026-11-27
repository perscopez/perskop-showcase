import type Database from "better-sqlite3";
import { classifyMail, type MailCategory, type SenderRule } from "./classification.js";

export type StoredGmailMessage = {
  messageId: string;
  threadId: string;
  rfcMessageId: string | null;
  internalDate: string;
  subject: string;
  from: string;
  snippet: string;
  labelIds: string[];
  bodyText: string;
  payload: unknown;
};

export type StoredGmailThread = {
  accountId: string;
  threadId: string;
  historyId: string | null;
  subject: string;
  from: string;
  snippet: string;
  lastMessageAt: string;
  labelIds: string[];
  unread: boolean;
  starred: boolean;
  hidden: boolean;
  category: MailCategory;
  score: number;
  reasons: string[];
  messages: StoredGmailMessage[];
};

export type StoredGmailLabel = {
  accountId: string;
  labelId: string;
  name: string;
  type: string | null;
  metadata: Record<string, unknown>;
};

export type GmailDraftAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  dataBase64: string;
};

export type StoredGmailDraft = {
  draftId: string;
  accountId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  attachments: GmailDraftAttachment[];
  revision: number;
  status: "draft" | "waiting_approval" | "approved" | "sent";
  createdAt: string;
  updatedAt: string;
};

export class GmailStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_accounts (
        account_id TEXT PRIMARY KEY,
        email_address TEXT NOT NULL,
        history_id TEXT,
        last_sync_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS gmail_labels (
        account_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT,
        label_json TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS gmail_threads (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        history_id TEXT,
        subject TEXT NOT NULL,
        from_address TEXT NOT NULL,
        snippet TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        label_ids_json TEXT NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT 'normal',
        score INTEGER NOT NULL DEFAULT 0,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_gmail_threads_list
        ON gmail_threads(account_id, hidden, category, last_message_at DESC);
      CREATE TABLE IF NOT EXISTS gmail_messages (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        rfc_message_id TEXT,
        internal_date TEXT NOT NULL,
        subject TEXT NOT NULL,
        from_address TEXT NOT NULL,
        snippet TEXT NOT NULL,
        label_ids_json TEXT NOT NULL,
        body_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES gmail_threads(account_id, thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_gmail_messages_thread
        ON gmail_messages(account_id, thread_id, internal_date);
      CREATE INDEX IF NOT EXISTS idx_gmail_messages_rfc_id
        ON gmail_messages(account_id, rfc_message_id);
      CREATE TABLE IF NOT EXISTS gmail_drafts (
        draft_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        thread_id TEXT,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        bcc_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_gmail_drafts_account ON gmail_drafts(account_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS gmail_send_operations (
        operation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        approval_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        provider_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (draft_id) REFERENCES gmail_drafts(draft_id) ON DELETE CASCADE,
        FOREIGN KEY (approval_id) REFERENCES approvals(id)
      );
      CREATE INDEX IF NOT EXISTS idx_gmail_send_operations_draft ON gmail_send_operations(draft_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS gmail_unsubscribe_operations (
        operation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        approval_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        results_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (approval_id) REFERENCES approvals(id)
      );
      CREATE TABLE IF NOT EXISTS mail_sender_rules (
        pattern TEXT PRIMARY KEY COLLATE NOCASE,
        action TEXT NOT NULL CHECK(action IN ('important', 'promotion', 'normal')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  listSenderRules(): SenderRule[] {
    return (this.db.prepare("SELECT pattern, action FROM mail_sender_rules ORDER BY pattern COLLATE NOCASE").all() as SenderRule[]);
  }

  upsertSenderRule(rule: SenderRule): SenderRule {
    const pattern = rule.pattern.trim().toLowerCase();
    this.db.prepare(`
      INSERT INTO mail_sender_rules (pattern, action) VALUES (?, ?)
      ON CONFLICT(pattern) DO UPDATE SET action=excluded.action, updated_at=datetime('now')
    `).run(pattern, rule.action);
    this.reclassifyThreads();
    return { pattern, action: rule.action };
  }

  deleteSenderRule(pattern: string): number {
    const changes = this.db.prepare("DELETE FROM mail_sender_rules WHERE pattern=? COLLATE NOCASE").run(pattern.trim()).changes;
    if (changes) this.reclassifyThreads();
    return changes;
  }

  reclassifyThreads(): number {
    const rules = this.listSenderRules();
    const rows = this.db.prepare("SELECT account_id, thread_id, subject, from_address, snippet, label_ids_json FROM gmail_threads").all() as any[];
    const update = this.db.prepare(`
      UPDATE gmail_threads SET hidden=?, category=?, score=?, reasons_json=?, updated_at=datetime('now')
      WHERE account_id=? AND thread_id=?
    `);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const labels = JSON.parse(row.label_ids_json) as string[];
        const classification = classifyMail({
          subject: row.subject,
          from: row.from_address,
          snippet: row.snippet,
          labels,
          seen: !labels.includes("UNREAD"),
        }, rules);
        update.run(
          classification.hidden ? 1 : 0,
          classification.category,
          classification.score,
          JSON.stringify(classification.reasons),
          row.account_id,
          row.thread_id,
        );
      }
    });
    transaction();
    return rows.length;
  }

  upsertAccount(input: { accountId: string; emailAddress: string; historyId?: string | null }) {
    this.db.prepare(`
      INSERT INTO gmail_accounts (account_id, email_address, history_id, last_sync_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET
        email_address=excluded.email_address,
        history_id=excluded.history_id,
        last_sync_at=datetime('now')
    `).run(input.accountId, input.emailAddress, input.historyId ?? null);
  }

  getAccount(accountId: string): { accountId: string; emailAddress: string; historyId: string | null; lastSyncAt: string } | null {
    const row = this.db.prepare("SELECT * FROM gmail_accounts WHERE account_id=?").get(accountId) as any;
    return row ? { accountId: row.account_id, emailAddress: row.email_address, historyId: row.history_id, lastSyncAt: row.last_sync_at } : null;
  }

  replaceLabels(accountId: string, labels: Array<{ id: string; name: string; type?: string }>) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM gmail_labels WHERE account_id=?").run(accountId);
      const insert = this.db.prepare("INSERT INTO gmail_labels (account_id,label_id,name,type,label_json) VALUES (?,?,?,?,?)");
      for (const label of labels) insert.run(accountId, label.id, label.name, label.type ?? null, JSON.stringify(label));
    });
    transaction();
  }

  listLabels(accountId: string): StoredGmailLabel[] {
    const rows = this.db.prepare(`
      SELECT account_id,label_id,name,type,label_json
      FROM gmail_labels WHERE account_id=?
      ORDER BY CASE type WHEN 'system' THEN 0 ELSE 1 END, name COLLATE NOCASE
    `).all(accountId) as any[];
    return rows.map((row) => ({
      accountId: row.account_id,
      labelId: row.label_id,
      name: row.name,
      type: row.type,
      metadata: JSON.parse(row.label_json),
    }));
  }

  upsertThread(thread: StoredGmailThread) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO gmail_threads (
          account_id,thread_id,history_id,subject,from_address,snippet,last_message_at,
          label_ids_json,unread,starred,hidden,category,score,reasons_json,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(account_id,thread_id) DO UPDATE SET
          history_id=excluded.history_id,subject=excluded.subject,from_address=excluded.from_address,
          snippet=excluded.snippet,last_message_at=excluded.last_message_at,label_ids_json=excluded.label_ids_json,
          unread=excluded.unread,starred=excluded.starred,hidden=excluded.hidden,category=excluded.category,
          score=excluded.score,reasons_json=excluded.reasons_json,updated_at=datetime('now')
      `).run(
        thread.accountId, thread.threadId, thread.historyId, thread.subject, thread.from,
        thread.snippet, thread.lastMessageAt, JSON.stringify(thread.labelIds), thread.unread ? 1 : 0,
        thread.starred ? 1 : 0, thread.hidden ? 1 : 0, thread.category, thread.score,
        JSON.stringify(thread.reasons),
      );
      this.db.prepare("DELETE FROM gmail_messages WHERE account_id=? AND thread_id=?").run(thread.accountId, thread.threadId);
      const insert = this.db.prepare(`
        INSERT INTO gmail_messages (
          account_id,message_id,thread_id,rfc_message_id,internal_date,subject,from_address,
          snippet,label_ids_json,body_text,payload_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const message of thread.messages) {
        insert.run(
          thread.accountId, message.messageId, message.threadId, message.rfcMessageId,
          message.internalDate, message.subject, message.from, message.snippet,
          JSON.stringify(message.labelIds), message.bodyText, JSON.stringify(message.payload),
        );
      }
    });
    transaction();
  }

  deleteThread(accountId: string, threadId: string) {
    return this.db.prepare("DELETE FROM gmail_threads WHERE account_id=? AND thread_id=?").run(accountId, threadId).changes;
  }

  listThreads(input: { accountId: string; includeHidden?: boolean; category?: MailCategory; q?: string; limit?: number; offset?: number }): Array<Omit<StoredGmailThread, "messages">> {
    const clauses = ["account_id=@accountId"];
    if (!input.includeHidden) clauses.push("hidden=0");
    if (input.category) clauses.push("category=@category");
    if (input.q) clauses.push("(subject LIKE @search OR from_address LIKE @search OR snippet LIKE @search)");
    const rows = this.db.prepare(`
      SELECT * FROM gmail_threads WHERE ${clauses.join(" AND ")}
      ORDER BY score DESC, last_message_at DESC
      LIMIT @limit OFFSET @offset
    `).all({
      accountId: input.accountId,
      category: input.category ?? null,
      search: `%${input.q ?? ""}%`,
      limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
      offset: Math.max(input.offset ?? 0, 0),
    }) as any[];
    return rows.map((row) => this.threadFromRow(row));
  }

  getThread(accountId: string, threadId: string): StoredGmailThread | null {
    const row = this.db.prepare("SELECT * FROM gmail_threads WHERE account_id=? AND thread_id=?").get(accountId, threadId) as any;
    if (!row) return null;
    const messages = (this.db.prepare("SELECT * FROM gmail_messages WHERE account_id=? AND thread_id=? ORDER BY internal_date").all(accountId, threadId) as any[]).map((message) => ({
      messageId: message.message_id,
      threadId: message.thread_id,
      rfcMessageId: message.rfc_message_id,
      internalDate: message.internal_date,
      subject: message.subject,
      from: message.from_address,
      snippet: message.snippet,
      labelIds: JSON.parse(message.label_ids_json),
      bodyText: message.body_text,
      payload: JSON.parse(message.payload_json),
    }));
    return { ...this.threadFromRow(row), messages };
  }

  createDraft(input: Omit<StoredGmailDraft, "revision" | "status" | "createdAt" | "updatedAt">): StoredGmailDraft {
    this.db.prepare(`
      INSERT INTO gmail_drafts (draft_id,account_id,thread_id,to_json,cc_json,bcc_json,subject,body_text,attachments_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      input.draftId, input.accountId, input.threadId, JSON.stringify(input.to), JSON.stringify(input.cc),
      JSON.stringify(input.bcc), input.subject, input.bodyText, JSON.stringify(input.attachments),
    );
    return this.getDraft(input.accountId, input.draftId)!;
  }

  updateDraft(input: Omit<StoredGmailDraft, "revision" | "status" | "createdAt" | "updatedAt">): StoredGmailDraft | null {
    const result = this.db.prepare(`
      UPDATE gmail_drafts SET
        thread_id=?,to_json=?,cc_json=?,bcc_json=?,subject=?,body_text=?,attachments_json=?,
        revision=revision+1,status='draft',updated_at=datetime('now')
      WHERE account_id=? AND draft_id=? AND status != 'sent'
    `).run(
      input.threadId, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
      input.subject, input.bodyText, JSON.stringify(input.attachments), input.accountId, input.draftId,
    );
    return result.changes ? this.getDraft(input.accountId, input.draftId) : null;
  }

  getDraft(accountId: string, draftId: string): StoredGmailDraft | null {
    const row = this.db.prepare("SELECT * FROM gmail_drafts WHERE account_id=? AND draft_id=?").get(accountId, draftId) as any;
    return row ? this.draftFromRow(row) : null;
  }

  listDrafts(accountId: string): StoredGmailDraft[] {
    return (this.db.prepare("SELECT * FROM gmail_drafts WHERE account_id=? ORDER BY updated_at DESC").all(accountId) as any[]).map((row) => this.draftFromRow(row));
  }

  deleteDraft(accountId: string, draftId: string): number {
    return this.db.prepare("DELETE FROM gmail_drafts WHERE account_id=? AND draft_id=? AND status != 'sent'").run(accountId, draftId).changes;
  }

  setDraftStatus(accountId: string, draftId: string, status: StoredGmailDraft["status"]): number {
    return this.db.prepare("UPDATE gmail_drafts SET status=?,updated_at=datetime('now') WHERE account_id=? AND draft_id=?").run(status, accountId, draftId).changes;
  }

  private threadFromRow(row: any): Omit<StoredGmailThread, "messages"> {
    return {
      accountId: row.account_id,
      threadId: row.thread_id,
      historyId: row.history_id,
      subject: row.subject,
      from: row.from_address,
      snippet: row.snippet,
      lastMessageAt: row.last_message_at,
      labelIds: JSON.parse(row.label_ids_json),
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      hidden: Boolean(row.hidden),
      category: row.category,
      score: row.score,
      reasons: JSON.parse(row.reasons_json),
    };
  }

  private draftFromRow(row: any): StoredGmailDraft {
    return {
      draftId: row.draft_id,
      accountId: row.account_id,
      threadId: row.thread_id,
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      bcc: JSON.parse(row.bcc_json),
      subject: row.subject,
      bodyText: row.body_text,
      attachments: JSON.parse(row.attachments_json),
      revision: row.revision,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
