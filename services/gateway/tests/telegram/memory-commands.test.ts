import test from "node:test";
import assert from "node:assert/strict";
import { formatMemoryList, memoryQuery, rememberText } from "../../src/telegram/memoryCommands.js";

test("remember command extracts bounded text and redacts credentials", () => {
  assert.equal(rememberText("/remember Kısa Türkçe yanıtla"), "Kısa Türkçe yanıtla");
  assert.equal(rememberText("/remember password=secret-value"), "password=[REDACTED]");
  assert.equal(memoryQuery("/memory üniversite kararları"), "üniversite kararları");
});

test("memory list is concise and never prints stored content", () => {
  const output = formatMemoryList([{ id: 1, source: "telegram", user_id: "owner", project_id: "global", memory_type: "preference", title: "Dil tercihi", content: "private content", provider: null, expires_at: null, created_at: "2026-07-18T10:00:00.000Z" }]);
  assert.match(output, /Dil tercihi · preference/);
  assert.equal(output.includes("private content"), false);
});
