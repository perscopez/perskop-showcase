import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalEmailSendApproval,
  emailApprovalMatches,
  emailSendApprovalSchema,
  hashEmailSendApproval,
} from "../../src/security/emailApproval.js";

const base = {
  schemaVersion: 1 as const,
  operationType: "email_send" as const,
  taskId: 42,
  accountId: "google_mail_owner",
  draftId: "draft-1",
  threadId: "thread-1",
  to: ["recipient@example.com"],
  cc: ["copy@example.com"],
  bcc: ["private@example.com"],
  subject: "Final subject",
  bodyText: "Exact final body",
  attachments: [{ id: "attachment-1", filename: "proof.pdf", mimeType: "application/pdf", size: 3, sha256: "a".repeat(64) }],
  nonce: "nonce-that-is-long-enough",
};

const hash = (value = base) => hashEmailSendApproval(canonicalEmailSendApproval(value));

test("email approval canonicalizes object key ordering", () => {
  const reordered = {
    nonce: base.nonce,
    attachments: base.attachments,
    bodyText: base.bodyText,
    subject: base.subject,
    bcc: base.bcc,
    cc: base.cc,
    to: base.to,
    threadId: base.threadId,
    draftId: base.draftId,
    accountId: base.accountId,
    taskId: base.taskId,
    operationType: base.operationType,
    schemaVersion: base.schemaVersion,
  };
  assert.equal(hash(base), hash(reordered));
});

test("every email send field mutation invalidates approval", () => {
  const approved = hash(base);
  const mutations = [
    { ...base, taskId: 43 },
    { ...base, accountId: "other-account" },
    { ...base, draftId: "draft-2" },
    { ...base, threadId: "thread-2" },
    { ...base, to: ["other@example.com"] },
    { ...base, cc: [] },
    { ...base, bcc: [] },
    { ...base, subject: "Edited subject" },
    { ...base, bodyText: "Edited body" },
    { ...base, attachments: [{ ...base.attachments[0], filename: "other.pdf" }] },
    { ...base, attachments: [{ ...base.attachments[0], sha256: "b".repeat(64) }] },
    { ...base, nonce: "another-long-enough-nonce" },
  ];
  for (const mutation of mutations) assert.equal(emailApprovalMatches(approved, hash(mutation as typeof base)), false);
});

test("email send approval rejects incomplete or ambiguous payloads", () => {
  const invalid = [
    { ...base, to: [] },
    { ...base, to: ["not-an-email"] },
    { ...base, attachments: [{ ...base.attachments[0], sha256: "not-a-hash" }] },
    { ...base, nonce: "short" },
    { ...base, html: "<b>hidden alternate body</b>" },
  ];
  for (const value of invalid) assert.equal(emailSendApprovalSchema.safeParse(value).success, false);
});
