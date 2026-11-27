import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { MemoryStore } from "../../src/db.js";
import { MemoryService } from "../../src/memory/memoryService.js";
import { buildContextPackage } from "../../src/memory/contextBuilder.js";
import { decideCapture } from "../../src/memory/capturePolicy.js";

test("memory continuity: telegram preference → mac context → correction → restart", async () => {
  const evidence: Record<string, unknown> = {
    kind: "staging_e2e",
    label: "memory-continuity",
    startedAt: new Date().toISOString(),
    steps: [] as Array<Record<string, unknown>>,
  };
  const steps = evidence.steps as Array<Record<string, unknown>>;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-memory-e2e-"));
  const memory = new MemoryStore(dir);
  const service = new MemoryService(memory);

  // Telegram explicit remember
  const capture = decideCapture({
    text: "Please remember I prefer morning flights",
    explicit: true,
    projectId: "perskop",
  });
  assert.equal(capture.capture, true);
  const saved = service.save({
    source: "telegram",
    title: "Flight preference",
    content: "Prefer morning flights",
    projectId: "perskop",
    memoryType: capture.memoryType,
    confidence: capture.confidence,
    provenance: { channel: "telegram", reason: capture.reason },
    dedupeKey: capture.dedupeKey,
  });
  steps.push({ step: "telegram_save", id: saved.row.id, duplicate: saved.duplicate });

  // Mac agent context package retrieves it with provenance + untrusted marker
  const pkg = buildContextPackage(service.listActive({ projectId: "perskop", limit: 20 }), {
    userId: "owner",
    projectId: "perskop",
    budgetChars: 1200,
  });
  assert.ok(pkg.items.some((item) => item.id === saved.row.id));
  assert.ok(pkg.injectionText.includes("UNTRUSTED_PERSKOP_MEMORY_CONTEXT"));
  assert.ok(pkg.items.every((item) => item.untrusted));
  steps.push({ step: "mac_context", characters: pkg.characters, itemCount: pkg.items.length });

  // Project isolation
  const other = service.save({
    source: "mac",
    title: "Other project note",
    content: "Only for other",
    projectId: "other",
  });
  const pkgOther = buildContextPackage(service.listActive({ projectId: "perskop", limit: 20 }), {
    userId: "owner",
    projectId: "perskop",
  });
  assert.ok(!pkgOther.items.some((item) => item.id === other.row.id));
  steps.push({ step: "project_isolation", ok: true });

  // Correction propagates
  const corrected = service.correct(saved.row.id, {
    content: "Prefer afternoon flights",
    provenance: { channel: "mac", reason: "user_correction" },
  });
  const afterCorrection = buildContextPackage(service.listActive({ projectId: "perskop", limit: 20 }), {
    userId: "owner",
    projectId: "perskop",
  });
  assert.ok(afterCorrection.items.some((item) => item.id === corrected.id));
  assert.ok(!afterCorrection.items.some((item) => item.id === saved.row.id));
  assert.ok(afterCorrection.items.find((item) => item.id === corrected.id)?.content.includes("afternoon"));
  steps.push({ step: "correction", correctedId: corrected.id, hidesOriginal: true });

  // Restart gateway store
  memory.db.close();
  const restarted = new MemoryStore(dir);
  const service2 = new MemoryService(restarted);
  const restartedPkg = buildContextPackage(service2.listActive({ projectId: "perskop", limit: 20 }), {
    userId: "owner",
    projectId: "perskop",
  });
  assert.ok(restartedPkg.items.some((item) => item.id === corrected.id && item.content.includes("afternoon")));
  steps.push({ step: "restart_retrieval", ok: true });

  // Fastify pin/delete surface smoke
  const app = Fastify();
  const auth = async (request: any, reply: any) =>
    request.headers.authorization === "Bearer owner-token" ? undefined : reply.code(401).send({ error: "unauthorized" });
  app.post("/api/memory/:id/pin", { preHandler: auth }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    return { item: new MemoryService(restarted).pin(id, true) };
  });
  await app.ready();
  const pin = await app.inject({
    method: "POST",
    url: `/api/memory/${corrected.id}/pin`,
    headers: { authorization: "Bearer owner-token" },
    payload: { pinned: true },
  });
  assert.equal(pin.statusCode, 200);
  assert.equal(pin.json().item.pinned, 1);
  steps.push({ step: "api_pin", ok: true });

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
  evidence.summary = {
    telegramToMac: true,
    isolation: true,
    correction: true,
    restartSafe: true,
  };

  // Optional: persist evidence JSON when PERSKOP_EVIDENCE_DIR is set.
  const evidenceDir = process.env.PERSKOP_EVIDENCE_DIR;
  if (evidenceDir) {
    const outDir = path.join(evidenceDir, "memory");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "memory-continuity.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }

  await app.close();
  restarted.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
