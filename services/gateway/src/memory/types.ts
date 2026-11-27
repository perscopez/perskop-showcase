export type MemorySensitivity = "public" | "personal" | "sensitive" | "secret";

export type MemoryProvenance = {
  channel?: string;
  agent?: string;
  taskId?: number | null;
  sessionId?: string | null;
  capturedAt?: string;
  reason?: string;
  [key: string]: unknown;
};

export type DurableMemoryRow = {
  id: number;
  source: string;
  user_id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  provider: string | null;
  created_at: string;
  expires_at: string | null;
  confidence: number;
  sensitivity: MemorySensitivity | string;
  provenance_json: string | null;
  revision: number;
  pinned: number;
  deleted_at: string | null;
  corrected_by_id: number | null;
  corrects_id: number | null;
  retention_days: number | null;
  dedupe_key: string | null;
};

export function parseProvenance(raw: string | null | undefined): MemoryProvenance | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MemoryProvenance) : null;
  } catch {
    return null;
  }
}

export function mapMemoryRow(row: Record<string, unknown>): DurableMemoryRow {
  return {
    id: Number(row.id),
    source: String(row.source || "system"),
    user_id: String(row.user_id || "owner"),
    project_id: String(row.project_id || "global"),
    memory_type: String(row.memory_type || "note"),
    title: String(row.title || ""),
    content: String(row.content || ""),
    provider: row.provider == null ? null : String(row.provider),
    created_at: String(row.created_at || ""),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    confidence: Number(row.confidence ?? 0.5),
    sensitivity: String(row.sensitivity || "personal"),
    provenance_json: row.provenance_json == null ? null : String(row.provenance_json),
    revision: Number(row.revision ?? 1) || 1,
    pinned: Number(row.pinned ?? 0) ? 1 : 0,
    deleted_at: row.deleted_at == null ? null : String(row.deleted_at),
    corrected_by_id: row.corrected_by_id == null ? null : Number(row.corrected_by_id),
    corrects_id: row.corrects_id == null ? null : Number(row.corrects_id),
    retention_days: row.retention_days == null ? null : Number(row.retention_days),
    dedupe_key: row.dedupe_key == null ? null : String(row.dedupe_key),
  };
}
