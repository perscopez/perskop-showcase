import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { MemoryService } from "../../src/memory/memoryService.js";
import { mapMemoryRow } from "../../src/memory/types.js";

test("memory schema migration adds durable metadata columns idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-memory-schema-"));
  const first = new MemoryStore(dir);
  const columns = first.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const required of [
    "confidence",
    "sensitivity",
    "provenance_json",
    "revision",
    "pinned",
    "deleted_at",
    "corrected_by_id",
    "corrects_id",
    "retention_days",
    "dedupe_key",
  ]) {
    assert.ok(names.has(required), `missing ${required}`);
  }

  const seeded = first.addMemory({
    source: "telegram",
    title: "Prefer dark mode",
    content: "UI preference",
    memoryType: "preference",
  });
  assert.equal(Number((seeded as any).revision ?? 1), 1);

  first.db.close();
  const second = new MemoryStore(dir);
  const again = second.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  assert.equal(again.filter((column) => column.name === "confidence").length, 1);
  const mapped = mapMemoryRow(second.getMemory(seeded.id) as any);
  assert.equal(mapped.sensitivity, "personal");
  assert.equal(mapped.pinned, 0);
  assert.equal(mapped.deleted_at, null);
  second.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("memory service supports save, dedupe, correction, pin, soft delete, isolation, and secret rejection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-memory-service-"));
  const store = new MemoryStore(dir);
  const memory = new MemoryService(store);

  const saved = memory.save({
    source: "telegram",
    title: "Visa preference",
    content: "Prefer morning appointments",
    memoryType: "preference",
    dedupeKey: "visa:morning",
    provenance: { channel: "telegram", reason: "explicit_remember" },
    confidence: 0.9,
  });
  assert.equal(saved.duplicate, false);

  const dup = memory.save({
    source: "telegram",
    title: "Visa preference",
    content: "Prefer morning appointments",
    dedupeKey: "visa:morning",
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.row.id, saved.row.id);

  const corrected = memory.correct(saved.row.id, {
    content: "Prefer afternoon appointments",
    provenance: { reason: "user_correction" },
  });
  assert.equal(corrected.corrects_id, saved.row.id);
  assert.equal(memory.get(saved.row.id)?.corrected_by_id, corrected.id);

  const pinned = memory.pin(corrected.id, true);
  assert.equal(pinned?.pinned, 1);
  const deleted = memory.softDelete(corrected.id);
  assert.ok(deleted?.deleted_at);

  const other = memory.save({
    source: "mac",
    title: "Other project",
    content: "Unrelated",
    userId: "owner",
    projectId: "other",
  });
  const listed = memory.listActive({ projectId: "global" });
  assert.ok(!listed.some((item) => item.id === other.row.id));
  assert.ok(!listed.some((item) => item.id === corrected.id));

  assert.throws(() => memory.save({
    source: "telegram",
    title: "Leak",
    content: "api_key=sk-test-123456",
  }), /secret_like/);

  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
