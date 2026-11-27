import test from "node:test";
import assert from "node:assert/strict";
import { conversationMemoryContent, redactConversationSecrets } from "../../src/memory/conversation.js";

test("conversation memory preserves user intent and agent ownership", () => {
  const content = conversationMemoryContent({ prompt: "Kısa Türkçe yaz", response: "Tamam", provider: "codex" });
  assert.match(content, /User request:\nKısa Türkçe yaz/);
  assert.match(content, /Agent response \(codex\):\nTamam/);
});

test("conversation memory redacts common connector and bot credentials", () => {
  const value = redactConversationSecrets([
    "Authorization: Bearer secret-access-token",
    "client_secret=GOCSPX-exampleSecret",
    "bot 123456789:abcdefghijklmnopqrstuvwxyzABCDE12345",
    "app swgz-sbwh-hxgm-ppqt",
  ].join("\n"));
  assert.equal(value.includes("secret-access-token"), false);
  assert.equal(value.includes("GOCSPX-exampleSecret"), false);
  assert.equal(value.includes("123456789:"), false);
  assert.equal(value.includes("swgz-sbwh-hxgm-ppqt"), false);
  assert.equal((value.match(/\[REDACTED\]/g) ?? []).length, 4);
});
