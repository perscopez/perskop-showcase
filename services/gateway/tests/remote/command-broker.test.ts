import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteRemotePromptPayload,
  getRemotePromptPayload,
  publishRemoteCommandResult,
  putRemotePromptPayload,
  waitForRemoteCommandResult,
} from "../../src/remote/commandBroker.js";

test("remote command broker delivers transient results without database persistence", async () => {
  const waiting = waitForRemoteCommandResult("command", 100);
  publishRemoteCommandResult("command", { ok: true, result: "summary" });
  assert.deepEqual(await waiting, { ok: true, result: "summary" });
  assert.equal(await waitForRemoteCommandResult("missing", 5), null);
});

test("remote prompt payloads are isolated, expiring, and deletable", () => {
  putRemotePromptPayload("one", "first", 100, 1_000);
  putRemotePromptPayload("two", "second", 100, 1_000);
  assert.equal(getRemotePromptPayload("one", 1_050), "first");
  assert.equal(getRemotePromptPayload("two", 1_050), "second");
  assert.equal(getRemotePromptPayload("one", 1_101), null);
  deleteRemotePromptPayload("two");
  assert.equal(getRemotePromptPayload("two", 1_050), null);
});
