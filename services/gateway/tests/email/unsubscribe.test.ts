import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUnsubscribeApproval, extractUnsubscribeCandidate, hashUnsubscribeApproval, unsubscribeApprovalMatches } from "../../src/email/unsubscribe.js";

const thread = (list: string, post = "") => ({
  accountId: "mail-1", threadId: "thread-1", historyId: "1", subject: "Sale", from: "Shop <sale@example.com>", snippet: "", lastMessageAt: "2026-01-01T00:00:00.000Z", labelIds: ["CATEGORY_PROMOTIONS"], unread: false, starred: false, hidden: true, category: "promotion", score: -10, reasons: [],
  messages: [{ messageId: "message-1", threadId: "thread-1", rfcMessageId: null, internalDate: "2026-01-01T00:00:00.000Z", subject: "Sale", from: "Shop <sale@example.com>", snippet: "", labelIds: [], bodyText: "", payload: { headers: [{ name: "List-Unsubscribe", value: list }, { name: "List-Unsubscribe-Post", value: post }] } }],
} as any);

test("extracts RFC 8058 one-click and mailto methods but rejects unsafe HTTP", () => {
  const candidate = extractUnsubscribeCandidate(thread("<mailto:leave@example.com?subject=unsubscribe>, <https://example.com/unsubscribe/abc>", "List-Unsubscribe=One-Click"));
  assert.equal(candidate?.oneClickUrl, "https://example.com/unsubscribe/abc");
  assert.match(candidate?.mailtoUrl ?? "", /^mailto:/);
  assert.equal(extractUnsubscribeCandidate(thread("<http://example.com/unsubscribe>")), null);
});

test("unsubscribe batch approval binds every selected sender and method", () => {
  const base = { schemaVersion: 1 as const, operationType: "email_unsubscribe" as const, taskId: 1, accountId: "mail-1", candidates: [{ id: "candidate-1", sender: "Shop <sale@example.com>", oneClickUrl: "https://example.com/u", mailtoUrl: null }], nonce: "nonce-that-is-long-enough" };
  const approved = hashUnsubscribeApproval(canonicalUnsubscribeApproval(base));
  const changedSender = hashUnsubscribeApproval(canonicalUnsubscribeApproval({ ...base, candidates: [{ ...base.candidates[0], sender: "Other <other@example.com>" }] }));
  const changedMethod = hashUnsubscribeApproval(canonicalUnsubscribeApproval({ ...base, candidates: [{ ...base.candidates[0], oneClickUrl: "https://example.com/other" }] }));
  assert.equal(unsubscribeApprovalMatches(approved, changedSender), false);
  assert.equal(unsubscribeApprovalMatches(approved, changedMethod), false);
});
