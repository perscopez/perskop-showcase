import type Database from "better-sqlite3";
import type { NormalizedProviderFailure } from "./types.js";

export type ProviderRuntimeStatus = "unknown" | "healthy" | "cooldown" | "unavailable";

export type ProviderRuntimeStateRow = {
  provider: string;
  node_id: string;
  capability: string;
  status: ProviderRuntimeStatus;
  consecutive_failures: number;
  opened_at: string | null;
  reset_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_latency_ms: number | null;
  last_error_kind: string | null;
  manual_pin: number;
  revision: number;
  updated_at: string;
};

type RuntimeKey = { provider: string; nodeId: string; capability: string };

const DEFAULT_COOLDOWN_MS: Record<string, number> = {
  rate_limit: 5 * 60_000,
  timeout: 30_000,
  transport: 30_000,
  malformed_response: 30_000,
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class ProviderRuntimeStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(provider: string, nodeId: string, capability: string): ProviderRuntimeStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM provider_runtime_state WHERE provider = ? AND node_id = ? AND capability = ?`)
      .get(provider, nodeId, capability) as ProviderRuntimeStateRow | undefined;
  }

  getPinned(nodeId: string, capability: string): ProviderRuntimeStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM provider_runtime_state WHERE node_id = ? AND capability = ? AND manual_pin = 1 ORDER BY updated_at DESC LIMIT 1`)
      .get(nodeId, capability) as ProviderRuntimeStateRow | undefined;
  }

  listFor(nodeId: string, capability: string): ProviderRuntimeStateRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_runtime_state WHERE node_id = ? AND capability = ? ORDER BY provider`)
      .all(nodeId, capability) as ProviderRuntimeStateRow[];
  }

  pin(provider: string | null, nodeId: string, capability: string, nowMs = Date.now()): void {
    const now = iso(nowMs);
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE provider_runtime_state SET manual_pin = 0, revision = revision + 1, updated_at = ? WHERE node_id = ? AND capability = ? AND manual_pin = 1`)
        .run(now, nodeId, capability);
      if (!provider) return;
      this.db.prepare(`
        INSERT INTO provider_runtime_state (provider, node_id, capability, manual_pin, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(provider, node_id, capability) DO UPDATE SET
          manual_pin = 1,
          revision = provider_runtime_state.revision + 1,
          updated_at = excluded.updated_at
      `).run(provider, nodeId, capability, now);
    })();
  }

  recordFailure(input: RuntimeKey & {
    failure: NormalizedProviderFailure;
    nowMs?: number;
  }): ProviderRuntimeStateRow {
    const nowMs = input.nowMs ?? Date.now();
    const now = iso(nowMs);
    const previous = this.get(input.provider, input.nodeId, input.capability);
    const defaultCooldown = DEFAULT_COOLDOWN_MS[input.failure.kind] ?? 0;
    const candidateReset = input.failure.cooldownUntil ?? (defaultCooldown ? iso(nowMs + defaultCooldown) : null);
    const resetAt = previous?.reset_at && candidateReset
      ? (previous.reset_at > candidateReset ? previous.reset_at : candidateReset)
      : candidateReset ?? previous?.reset_at ?? null;
    const status: ProviderRuntimeStatus = input.failure.retryable ? "cooldown" : "unavailable";
    const openedAt = previous?.status === status && previous.opened_at ? previous.opened_at : now;

    this.db.prepare(`
      INSERT INTO provider_runtime_state (
        provider, node_id, capability, status, consecutive_failures,
        opened_at, reset_at, last_failure_at, last_error_kind, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, node_id, capability) DO UPDATE SET
        status = excluded.status,
        consecutive_failures = provider_runtime_state.consecutive_failures + 1,
        opened_at = excluded.opened_at,
        reset_at = excluded.reset_at,
        last_failure_at = excluded.last_failure_at,
        last_error_kind = excluded.last_error_kind,
        revision = provider_runtime_state.revision + 1,
        updated_at = excluded.updated_at
    `).run(
      input.provider,
      input.nodeId,
      input.capability,
      status,
      openedAt,
      status === "cooldown" ? resetAt : null,
      now,
      input.failure.kind,
      now,
    );
    return this.get(input.provider, input.nodeId, input.capability)!;
  }

  recordSuccess(input: RuntimeKey & { latencyMs?: number; nowMs?: number }): ProviderRuntimeStateRow {
    const now = iso(input.nowMs ?? Date.now());
    this.db.prepare(`
      INSERT INTO provider_runtime_state (
        provider, node_id, capability, status, consecutive_failures,
        last_success_at, last_latency_ms, updated_at
      ) VALUES (?, ?, ?, 'healthy', 0, ?, ?, ?)
      ON CONFLICT(provider, node_id, capability) DO UPDATE SET
        status = 'healthy',
        consecutive_failures = 0,
        opened_at = NULL,
        reset_at = NULL,
        last_success_at = excluded.last_success_at,
        last_latency_ms = excluded.last_latency_ms,
        last_error_kind = NULL,
        revision = provider_runtime_state.revision + 1,
        updated_at = excluded.updated_at
    `).run(input.provider, input.nodeId, input.capability, now, input.latencyMs ?? null, now);
    return this.get(input.provider, input.nodeId, input.capability)!;
  }

  clearElapsedCooldowns(nowMs = Date.now()): number {
    const now = iso(nowMs);
    return this.db.prepare(`
      UPDATE provider_runtime_state
      SET status = 'unknown', opened_at = NULL, reset_at = NULL,
          revision = revision + 1, updated_at = ?
      WHERE status = 'cooldown' AND reset_at IS NOT NULL AND reset_at <= ?
    `).run(now, now).changes;
  }
}
