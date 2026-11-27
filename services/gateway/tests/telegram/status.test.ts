import test from "node:test";
import assert from "node:assert/strict";
import { formatBotStatus } from "../../src/telegram/status.js";

test("Telegram status summarizes disk, sync, memory, and provider cooldowns", () => {
  const output = formatBotStatus({
    diskPct: 65,
    diskFreeGb: 13.2,
    gmailConnected: 1,
    gmailLastSync: "2026-07-18T12:00:00.000Z",
    imapLastSync: "2026-07-18T12:05:00.000Z",
    memoryCount: 42,
    macOnline: true,
    macSessionCount: 7,
    providers: [
      { provider: "codex", status: "healthy" },
      { provider: "direct_model", status: "cooldown", error: "rate_limit" },
    ],
  });
  assert.match(output, /Disk: %65 dolu · 13\.2 GB boş/);
  assert.match(output, /Gmail API: 1 hesap/);
  assert.match(output, /Hafıza: 42 kayıt/);
  assert.match(output, /Mac: çevrimiçi · 7 oturum/);
  assert.match(output, /🟢 codex: healthy/);
  assert.match(output, /🟡 direct_model: cooldown \(rate_limit\)/);
});
