import test from "node:test";
import assert from "node:assert/strict";
import { formatInboxBrief, type InboxMessage } from "../src/email/inbox.js";

const msg = (index: number, subject: string, from: string, seen = false): InboxMessage => ({
  uid: index,
  index,
  subject,
  from,
  seen,
  date: `2026-07-17T0${index % 9}:00:00.000Z`,
});

test("mail brief hides promotions and prioritizes university/language process mail", () => {
  const brief = formatInboxBrief([
    msg(1, "Summer sale discount", "promo@example.com"),
    msg(2, "Goethe Kurs Termin wichtig", "kurs@goethe.de"),
    msg(3, "University application deadline", "admissions@uni.edu", true),
    msg(4, "Hello", "friend@example.com", true),
    msg(5, "Important changes to your free access", "info@cerebras.net"),
    msg(6, "Last call: Don't miss Docker MCP", "no-reply@docker.com"),
  ]);
  assert.match(brief, /reklamlar gizlendi \(3\)/);
  assert.match(brief, /Goethe Kurs/);
  assert.match(brief, /University application/);
  assert.equal(brief.includes("Summer sale"), false);
  assert.equal(brief.includes("Cerebras"), false);
  assert.equal(brief.includes("Docker MCP"), false);
  assert.equal(brief.includes("friend@example.com"), false);
  assert.match(brief, /Diğer 1 mail sessize alındı/);
});

test("mail brief applies the same persisted-style sender overrides as Gmail", () => {
  const hidden = formatInboxBrief([
    msg(1, "University application deadline", "admissions@uni.edu"),
  ], [{ pattern: "@uni.edu", action: "promotion" }]);
  assert.match(hidden, /reklamlar gizlendi \(1\)/);
  assert.equal(hidden.includes("University application deadline"), false);

  const promoted = formatInboxBrief([
    msg(2, "Weekly hello", "friend@example.com", true),
  ], [{ pattern: "friend@example.com", action: "important" }]);
  assert.match(promoted, /Weekly hello/);
  assert.match(promoted, /önemli/);
});

import { formatTrackedMailAlert, trackedMailSource } from "../src/email/syncWorker.js";

test("trackedMailSource matches Kapitel Zwei and every TU Dortmund mailbox", () => {
  assert.equal(trackedMailSource("berlin@kapitel-zwei.de"), "Kapitel Zwei");
  assert.equal(trackedMailSource("course-team@kapitel-zwei.de"), "Kapitel Zwei");
  assert.equal(trackedMailSource("Admission.Inquiries@tu-dortmund.de"), "TU Dortmund");
  assert.equal(trackedMailSource("someone@example.com"), null);
});

test("formatTrackedMailAlert creates a concise Telegram notification", () => {
  const text = formatTrackedMailAlert({
    uid: 42,
    index: 1,
    from: "admission.inquiries@tu-dortmund.de",
    subject: "Your application",
    date: "2026-07-17T12:00:00.000Z",
    seen: false,
  }, "  We received your documents.\n Please wait.  ");
  assert.match(text, /TU Dortmund'dan yeni mail geldi/);
  assert.match(text, /Konu: Your application/);
  assert.match(text, /We received your documents\. Please wait\./);
});
