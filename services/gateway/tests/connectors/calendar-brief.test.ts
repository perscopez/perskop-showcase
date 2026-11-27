import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";
import { formatCalendarBrief } from "../../src/connectors/calendar/brief.js";

test("calendar brief prioritizes today, tomorrow, important and next upcoming events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-brief-")); const memory = new MemoryStore(dir); const registry = new CalendarRegistry(memory.db);
  registry.upsertAccount({ id: "google", ownerId: "owner", source: "google", displayName: "Google", status: "connected" });
  registry.upsertCalendar({ id: "calendar", accountId: "google", sourceCalendarId: "primary", name: "Ana", color: null, capabilities: { read: true, create: true, update: true, delete: true }, freshness: "fresh", sourceVersion: null });
  const put = (id: string, title: string, startAt: string) => registry.upsertEvent({ id, calendarId: "calendar", sourceEventId: id, sourceVersion: null, eventJson: { title, allDay: false }, startsAt: startAt, endsAt: new Date(new Date(startAt).getTime() + 3600000).toISOString(), freshness: "fresh" });
  put("today", "Ders", "2026-07-14T14:00:00.000Z"); put("tomorrow", "Doktor", "2026-07-15T10:00:00.000Z"); put("exam", "Matematik sınav", "2026-07-18T09:00:00.000Z"); put("ordinary", "Spor", "2026-07-18T12:00:00.000Z");
  const brief = formatCalendarBrief(registry, { now: new Date("2026-07-14T09:00:00.000Z"), timeZone: "Europe/Istanbul" });
  assert.match(brief, /Bugün[\s\S]*Ders/); assert.match(brief, /Yarın[\s\S]*Doktor/); assert.match(brief, /Önümüzdeki 60 gün — önemli[\s\S]*Matematik sınav/); assert.match(brief, /Önümüzdeki 60 gün — sıradaki[\s\S]*Spor/);
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
