import test from "node:test";
import assert from "node:assert/strict";
import { formatNodeList, formatTaskDetail, formatTaskList } from "../../src/telegram/taskCommands.js";

test("Telegram task list is concise and shows live state", () => {
  const text = formatTaskList([
    { id: 12, prompt: "Perskop'u geliştir", status: "running", provider: "codex" },
    { id: 11, prompt: "Brief", status: "done", provider: "direct_model" },
    { id: 10, prompt: "Mac işi", status: "waiting_for_node", target_node_id: "mac" },
  ]);
  assert.match(text, /⏳ #12 · running · codex/);
  assert.match(text, /✅ #11 · done · direct_model/);
  assert.match(text, /💻 #10 · waiting_for_node · →mac/);
  assert.match(text, /\/cancel/);
});

test("Telegram task detail and node list summarize cross-device state", () => {
  assert.match(
    formatTaskDetail({
      id: 7,
      status: "waiting_for_node",
      prompt: "Kod düzelt",
      target_node_id: "mac",
      parent_session_id: "session-abcdef12",
    }),
    /Görev #7[\s\S]*Hedef: mac[\s\S]*Oturum: abcdef12/,
  );
  const nodes = formatNodeList([
    {
      id: "mac",
      displayName: "MacBook",
      online: true,
      currentLoad: 1,
      sessionCount: 3,
    },
    {
      id: "mac-old",
      displayName: "Eski",
      online: false,
      currentLoad: 0,
      sessionCount: 0,
      revokedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  assert.match(nodes, /🟢 MacBook/);
  assert.match(nodes, /🚫 Eski/);
});
