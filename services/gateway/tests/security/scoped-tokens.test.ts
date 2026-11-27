import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-token-"));
  const store = new MemoryStore(dir);
  const taskId = store.addTask({ source: "mac", prompt: "token test" });
  return { dir, store, taskId };
}

test("plaintext scoped tokens are never persisted or logged in rows", () => {
  const { dir, store, taskId } = fixture();
  const token = store.issueScopedToken({ taskId, executorIdentity: "sandbox-executor" });
  const raw = store.db.prepare("SELECT * FROM scoped_tokens").get() as Record<string, unknown>;
  assert.equal(JSON.stringify(raw).includes(token), false);
  assert.equal(raw.token_hash, MemoryStore.hashToken(token));
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("active token survives restart but expired and revoked tokens do not validate", () => {
  const { dir, store, taskId } = fixture();
  const active = store.issueScopedToken({ taskId, executorIdentity: "sandbox-executor", expiresInMs: 60_000 });
  const expiredTask = store.addTask({ source: "mac", prompt: "expired" });
  const expired = store.issueScopedToken({ taskId: expiredTask, executorIdentity: "sandbox-executor", expiresInMs: -1 });
  const revoked = store.issueScopedToken({ taskId, executorIdentity: "other", expiresInMs: 60_000 });
  store.revokeScopedTokensByTask(taskId);
  // Issue an active token after the task-wide revocation to prove persistence.
  const restartActive = store.issueScopedToken({ taskId, executorIdentity: "sandbox-executor", expiresInMs: 60_000 });
  store.db.close();

  const restarted = new MemoryStore(dir);
  assert.equal(restarted.validateScopedToken(active, "sandbox-executor"), null);
  assert.equal(restarted.validateScopedToken(expired, "sandbox-executor"), null);
  assert.equal(restarted.validateScopedToken(revoked, "other"), null);
  assert.deepEqual(restarted.validateScopedToken(restartActive, "sandbox-executor"), { taskId, scope: "model_proxy" });
  assert.equal(restarted.getScopedToken(expired)?.status, "expired");
  assert.equal(restarted.getScopedToken(revoked)?.status, "revoked");
  restarted.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomic consumption rejects replay, wrong task, wrong executor, and wrong scope", async () => {
  const { dir, store, taskId } = fixture();
  const otherTask = store.addTask({ source: "mac", prompt: "other" });
  const issue = () => store.issueScopedToken({ taskId, executorIdentity: "sandbox-executor", scope: "model_proxy" });

  const wrongTask = issue();
  assert.equal(store.consumeScopedToken(wrongTask, "sandbox-executor", { taskId: otherTask }), null);
  const wrongExecutor = issue();
  assert.equal(store.consumeScopedToken(wrongExecutor, "other", { taskId }), null);
  const wrongScope = issue();
  assert.equal(store.consumeScopedToken(wrongScope, "sandbox-executor", { taskId, scope: "shell" }), null);

  const token = issue();
  const attempts = await Promise.all(
    Array.from({ length: 8 }, async () => store.consumeScopedToken(token, "sandbox-executor", { taskId, scope: "model_proxy" })),
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(store.consumeScopedToken(token, "sandbox-executor", { taskId }), null);
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("task completion, failure, timeout, cancellation, and rejection revoke active tokens", () => {
  for (const status of ["done", "failed", "timed_out", "cancelled", "rejected"]) {
    const { dir, store, taskId } = fixture();
    const token = store.issueScopedToken({ taskId, executorIdentity: "sandbox-executor" });
    store.updateTask(taskId, { status });
    assert.equal(store.validateScopedToken(token, "sandbox-executor"), null, status);
    assert.equal(store.getScopedToken(token)?.status, "revoked", status);
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
