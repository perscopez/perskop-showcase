import test from "node:test";
import assert from "node:assert/strict";
import { decideCapture } from "../../src/memory/capturePolicy.js";

test("capture policy distinguishes explicit, decision, preference, task outcomes, and transient chatter", () => {
  assert.equal(decideCapture({ text: "Please remember I prefer morning flights", explicit: true }).capture, true);
  assert.equal(decideCapture({ text: "We decided to use SQLite on the VPS" }).kind, "decision");
  assert.equal(decideCapture({ text: "I prefer Turkish replies" }).kind, "preference");
  assert.equal(decideCapture({ text: "Task finished", taskStatus: "succeeded", taskId: 12 }).kind, "task_summary");
  assert.equal(decideCapture({ text: "Boom", taskStatus: "failed", taskId: 12 }).kind, "failure_evidence");
  assert.equal(decideCapture({ text: "lol ok" }).capture, false);
  assert.equal(decideCapture({ text: "remember my api_key=sk-abc" }).capture, false);
});
