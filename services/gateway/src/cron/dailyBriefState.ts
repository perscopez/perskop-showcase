import type { MemoryStore } from "../db.js";

const SHOWN_KEY = "daily_brief_shown_mail_uids";
const MAX_SHOWN_UIDS = 5_000;

export function loadShownDailyBriefMailUids(memory: MemoryStore): Set<string> {
  const row = memory.db.prepare("SELECT value FROM settings WHERE key=?").get(SHOWN_KEY) as { value: string } | undefined;
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length <= 100));
  } catch {
    return new Set();
  }
}

export function markDailyBriefMailsShown(memory: MemoryStore, uids: Array<number | string>): void {
  if (!uids.length) return;
  const merged = [...loadShownDailyBriefMailUids(memory), ...uids.map(String)];
  const bounded = [...new Set(merged)].slice(-MAX_SHOWN_UIDS);
  memory.db.prepare(`
    INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(SHOWN_KEY, JSON.stringify(bounded));
}
