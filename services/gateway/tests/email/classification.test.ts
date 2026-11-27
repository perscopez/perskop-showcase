import test from "node:test";
import assert from "node:assert/strict";
import { classifyMail, trackedSenderSource } from "../../src/email/classification.js";

const mail = (subject: string, from: string, patch: Record<string, unknown> = {}) => ({
  subject,
  from,
  seen: false,
  ...patch,
});

test("classifies university, language-course, visa and deadline mail with reasons", () => {
  const university = classifyMail(mail("Your application documents", "admission.inquiries@tu-dortmund.de"));
  assert.equal(university.category, "priority");
  assert.equal(university.hidden, false);
  assert.ok(university.reasons.includes("university"));

  const course = classifyMail(mail("Intensive German course", "berlin@kapitel-zwei.de"));
  assert.equal(course.category, "priority");
  assert.ok(course.reasons.includes("language_course"));

  const visa = classifyMail(mail("Visa appointment: action required", "office@example.de"));
  assert.equal(visa.category, "urgent");
  assert.ok(visa.reasons.includes("visa"));
  assert.ok(visa.reasons.includes("action_required"));

  const deadline = classifyMail(mail("Application deadline tomorrow", "school@example.edu"));
  assert.equal(deadline.category, "urgent");
  assert.ok(deadline.score > university.score);
});

test("hides promotions without deleting them and keeps reasons inspectable", () => {
  const promotion = classifyMail(mail("Summer sale — unsubscribe here", "offers@shop.example", {
    labels: ["CATEGORY_PROMOTIONS"],
  }));
  assert.equal(promotion.category, "promotion");
  assert.equal(promotion.hidden, true);
  assert.ok(promotion.reasons.includes("gmail_promotions"));
  assert.ok(promotion.reasons.includes("marketing_language"));

  const ordinary = classifyMail(mail("Hello", "friend@example.com", { seen: true }));
  assert.equal(ordinary.category, "normal");
  assert.equal(ordinary.hidden, false);
});

test("explicit sender rules override automatic classification", () => {
  const important = classifyMail(
    mail("Newsletter sale", "updates@example.com"),
    [{ pattern: "updates@example.com", action: "important" }],
  );
  assert.equal(important.category, "priority");
  assert.equal(important.hidden, false);
  assert.ok(important.reasons.includes("sender_rule_important"));

  const hidden = classifyMail(
    mail("Personal hello", "noise@example.com"),
    [{ pattern: "@example.com", action: "promotion" }],
  );
  assert.equal(hidden.category, "promotion");
  assert.equal(hidden.hidden, true);
  assert.ok(hidden.reasons.includes("sender_rule_promotion"));
});

test("tracked sender names are shared with Telegram alerts", () => {
  assert.equal(trackedSenderSource("berlin@kapitel-zwei.de"), "Kapitel Zwei");
  assert.equal(trackedSenderSource("Admission.Inquiries@tu-dortmund.de"), "TU Dortmund");
  assert.equal(trackedSenderSource("friend@example.com"), null);
});
