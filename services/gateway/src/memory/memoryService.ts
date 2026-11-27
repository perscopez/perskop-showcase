import type { MemoryStore, MemoryRow, MemorySource } from "../db.js";
import {
  mapMemoryRow,
  parseProvenance,
  type DurableMemoryRow,
  type MemoryProvenance,
  type MemorySensitivity,
} from "./types.js";

const SECRET_RE = /(api[_-]?key|secret|token|password|bearer\s+[a-z0-9._-]+)/i;

export type SaveMemoryInput = {
  source: MemorySource | string;
  title: string;
  content: string;
  userId?: string;
  projectId?: string;
  memoryType?: string;
  provider?: string | null;
  expiresAt?: string | null;
  confidence?: number;
  sensitivity?: MemorySensitivity | string;
  provenance?: MemoryProvenance | null;
  pinned?: boolean;
  retentionDays?: number | null;
  dedupeKey?: string | null;
};

export class MemoryService {
  constructor(private readonly store: MemoryStore) {}

  map(row: MemoryRow | Record<string, unknown> | undefined | null): DurableMemoryRow | null {
    if (!row) return null;
    return mapMemoryRow(row as Record<string, unknown>);
  }

  containsSecretLike(text: string): boolean {
    return SECRET_RE.test(text);
  }

  save(input: SaveMemoryInput): { row: DurableMemoryRow; duplicate: boolean } {
    if (this.containsSecretLike(`${input.title}\n${input.content}`)) {
      throw new Error("memory_rejects_secret_like_content");
    }
    const userId = input.userId ?? "owner";
    const projectId = input.projectId ?? "global";
    const dedupeKey = input.dedupeKey ?? null;
    if (dedupeKey) {
      const existing = this.store.db
        .prepare(
          `SELECT * FROM memories
           WHERE user_id = ? AND project_id = ? AND dedupe_key = ?
             AND deleted_at IS NULL
           ORDER BY revision DESC, id DESC LIMIT 1`,
        )
        .get(userId, projectId, dedupeKey) as MemoryRow | undefined;
      if (existing) {
        return { row: mapMemoryRow(existing as any), duplicate: true };
      }
    }

    const info = this.store.db
      .prepare(
        `INSERT INTO memories (
          source, user_id, project_id, memory_type, title, content, provider, expires_at,
          confidence, sensitivity, provenance_json, revision, pinned, retention_days, dedupe_key
        ) VALUES (
          @source, @userId, @projectId, @memoryType, @title, @content, @provider, @expiresAt,
          @confidence, @sensitivity, @provenanceJson, 1, @pinned, @retentionDays, @dedupeKey
        )`,
      )
      .run({
        source: input.source,
        userId,
        projectId,
        memoryType: input.memoryType ?? "note",
        title: input.title,
        content: input.content,
        provider: input.provider ?? null,
        expiresAt: input.expiresAt ?? null,
        confidence: input.confidence ?? 0.7,
        sensitivity: input.sensitivity ?? "personal",
        provenanceJson: input.provenance ? JSON.stringify(input.provenance) : null,
        pinned: input.pinned ? 1 : 0,
        retentionDays: input.retentionDays ?? null,
        dedupeKey,
      });
    const row = this.get(Number(info.lastInsertRowid));
    if (!row) throw new Error("memory_insert_failed");
    return { row, duplicate: false };
  }

  get(id: number): DurableMemoryRow | null {
    const row = this.store.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
    return this.map(row);
  }

  pin(id: number, pinned = true): DurableMemoryRow | null {
    this.store.db.prepare(`UPDATE memories SET pinned = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL`)
      .run(pinned ? 1 : 0, id);
    return this.get(id);
  }

  softDelete(id: number, at = new Date().toISOString()): DurableMemoryRow | null {
    this.store.db
      .prepare(`UPDATE memories SET deleted_at = ?, pinned = 0, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL`)
      .run(at, id);
    return this.get(id);
  }

  correct(id: number, input: { title?: string; content: string; provenance?: MemoryProvenance | null }): DurableMemoryRow {
    const original = this.get(id);
    if (!original || original.deleted_at) throw new Error("memory_not_found");
    if (this.containsSecretLike(input.content) || (input.title && this.containsSecretLike(input.title))) {
      throw new Error("memory_rejects_secret_like_content");
    }
    const created = this.save({
      source: original.source,
      title: input.title ?? original.title,
      content: input.content,
      userId: original.user_id,
      projectId: original.project_id,
      memoryType: original.memory_type,
      provider: original.provider,
      confidence: Math.max(original.confidence, 0.85),
      sensitivity: original.sensitivity,
      provenance: {
        ...(parseProvenance(original.provenance_json) || {}),
        ...(input.provenance || {}),
        reason: "correction",
        correctsId: original.id,
      },
      pinned: Boolean(original.pinned),
      retentionDays: original.retention_days,
      dedupeKey: original.dedupe_key ? `${original.dedupe_key}:corrected:${Date.now()}` : null,
    }).row;

    this.store.db
      .prepare(
        `UPDATE memories
         SET corrected_by_id = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run(created.id, original.id);
    this.store.db
      .prepare(`UPDATE memories SET corrects_id = ? WHERE id = ?`)
      .run(original.id, created.id);
    return this.get(created.id)!;
  }

  listActive(input: {
    userId?: string;
    projectId?: string;
    limit?: number;
    includeDeleted?: boolean;
  } = {}): DurableMemoryRow[] {
    const userId = input.userId ?? "owner";
    const projectId = input.projectId ?? "global";
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const rows = this.store.db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ?
           AND (project_id = ? OR project_id = 'global')
           AND (? = 1 OR deleted_at IS NULL)
           AND (corrected_by_id IS NULL)
         ORDER BY pinned DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(userId, projectId, input.includeDeleted ? 1 : 0, limit) as MemoryRow[];
    return rows.map((row) => mapMemoryRow(row as any));
  }
}
