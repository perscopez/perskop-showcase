import test from "node:test";
import assert from "node:assert/strict";
import { splitTelegramMessage } from "../../src/telegram/messageChunks.js";
import { formatRemoteSessions, remoteSessionPrefix, remoteSessionPrompt } from "../../src/telegram/remoteCommands.js";

test("Telegram remote session list shows live state and short open command", () => {
  const now = Date.parse("2026-07-18T12:00:30.000Z");
  const text = formatRemoteSessions([{ session_id: "abcdef123456", title: "Perskop geliştirme", preview: null, is_active: 1, last_seen_at: "2026-07-18T12:00:00.000Z" }], now);
  assert.match(text, /🟢 Perskop geliştirme · çalışıyor/);
  assert.match(text, /\/open ef123456/);
  assert.equal(remoteSessionPrefix("/open@perskopbot abcdef12"), "abcdef12");
});

test("Telegram send parser preserves the full prompt", () => {
  assert.deepEqual(remoteSessionPrompt("/send@perskopbot ef123456   devam et ve testleri çalıştır"), {
    selector: "ef123456",
    prompt: "devam et ve testleri çalıştır",
  });
  assert.equal(remoteSessionPrompt("/send ef123456"), null);
  assert.equal(remoteSessionPrompt("/send"), null);
});

test("Telegram chunks preserve long Unicode responses without exceeding the limit", () => {
  const input = `${"uzun yanıt 🎯 ".repeat(400)}\n\nSon paragraf.`;
  const chunks = splitTelegramMessage(input, 3500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  const rebuilt = chunks.map((chunk) => chunk.replace(/^\[\d+\/\d+\]\n/, "")).join("");
  assert.equal(rebuilt, input);
});
