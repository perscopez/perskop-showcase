import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { canonicalize } from "../../src/utils/jcs.js";
import { MemoryStore } from "../../src/db.js";
import fs from "node:fs";

test("JCS Canonicalization", () => {
  // Key sorting
  const c1 = canonicalize({ b: 2, a: 1 });
  assert.strictEqual(c1, '{"a":1,"b":2}');

  // Nested object and key sorting
  const c2 = canonicalize({ z: [1, { y: 2, x: 1 }], a: null });
  assert.strictEqual(c2, '{"a":null,"z":[1,{"x":1,"y":2}]}');

  // String escaping
  const c3 = canonicalize("a\"b\\");
  assert.strictEqual(c3, '"a\\"b\\\\"');

  // Numbers serialization
  const c4 = canonicalize(-0);
  assert.strictEqual(c4, "0");

  const c5 = canonicalize(12.3);
  assert.strictEqual(c5, "12.3");
});

test("Database Schema Migrations & Approvals Store", () => {
  const testDir = `./test-data-${crypto.randomBytes(8).toString("hex")}`;
  const store = new MemoryStore(testDir);

  try {
    const taskId = store.addTask({
      source: "mac",
      prompt: "test prompt",
    });

    const approvalId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5m in future

    // 1. Create Approval
    store.createApproval({
      id: approvalId,
      taskId,
      requestedBy: "telegram:6176934407",
      channelId: "perskop",
      sessionId: "session-1",
      operationType: "repository_write",
      canonicalPayload: '{"change":"test"}',
      payloadHash: "dummy-hash",
      expiresAt,
      nonce,
    });

    const appr = store.getApproval(approvalId);
    assert.ok(appr);
    assert.strictEqual(appr.status, "pending");
    assert.strictEqual(appr.nonce, nonce);

    // 2. Nonce Uniqueness constraint
    assert.throws(() => {
      store.createApproval({
        id: crypto.randomUUID(),
        taskId,
        requestedBy: "telegram:6176934407",
        channelId: "perskop",
        sessionId: "session-1",
        operationType: "repository_write",
        canonicalPayload: '{"change":"test"}',
        payloadHash: "dummy-hash",
        expiresAt,
        nonce, // duplicate nonce!
      });
    }, /UNIQUE constraint failed/);

    // 3. Claiming approvals - cannot claim pending
    const claimedPending = store.claimApproval(approvalId);
    assert.strictEqual(claimedPending, false);

    // 4. Approve and Claim
    store.setApprovalStatus(approvalId, "approved", "admin");
    const apprApproved = store.getApproval(approvalId);
    assert.strictEqual(apprApproved?.status, "approved");
    assert.strictEqual(apprApproved?.approved_by, "admin");

    const claimedApproved = store.claimApproval(approvalId);
    assert.strictEqual(claimedApproved, true);

    // Claiming again should fail because status is now 'claimed'
    const claimedAgain = store.claimApproval(approvalId);
    assert.strictEqual(claimedAgain, false);

    // 5. Expiration check
    const expiredId = crypto.randomUUID();
    const expiredNonce = crypto.randomBytes(16).toString("hex");
    const pastExpires = new Date(Date.now() - 1000).toISOString(); // 1s in past

    store.createApproval({
      id: expiredId,
      taskId,
      requestedBy: "telegram:6176934407",
      channelId: "perskop",
      sessionId: "session-1",
      operationType: "repository_write",
      canonicalPayload: '{"change":"test"}',
      payloadHash: "dummy-hash",
      expiresAt: pastExpires,
      nonce: expiredNonce,
    });

    store.setApprovalStatus(expiredId, "approved", "admin");

    // Claiming expired approval should fail
    const claimedExpired = store.claimApproval(expiredId);
    assert.strictEqual(claimedExpired, false);

    // Run expire script
    store.expireStaleApprovals();
    const expiredAppr = store.getApproval(expiredId);
    assert.strictEqual(expiredAppr?.status, "expired");

  } finally {
    store.db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
