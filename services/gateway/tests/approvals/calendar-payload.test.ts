import test from "node:test";
import assert from "node:assert/strict";
import { calendarMutationSchema, canonicalCalendarApproval, equalCalendarApprovalHash, hashCalendarApproval } from "../../src/security/calendarApproval.js";
const mutation = { action: "create" as const, accountId: "a", calendarId: "c", title: "Ders", startAt: "2026-07-15T10:00:00.000Z", endAt: "2026-07-15T11:00:00.000Z", idempotencyKey: "x".repeat(16) };
test("calendar approval binds all mutation fields", () => {
  const canonical = canonicalCalendarApproval({ taskId: 1, nonce: "n", mutation }); const hash = hashCalendarApproval(canonical);
  const changed = canonicalCalendarApproval({ taskId: 1, nonce: "n", mutation: { ...mutation, title: "Başka Ders" } });
  assert.equal(equalCalendarApprovalHash(hash, hashCalendarApproval(changed)), false);
  assert.throws(() => calendarMutationSchema.parse({ ...mutation, extra: true }));
});
