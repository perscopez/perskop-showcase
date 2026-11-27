import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";

test("registry lists all calendars and returns chronological event ranges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-registry-"));
  const store = new MemoryStore(dir);
  const registry = new CalendarRegistry(store.db);
  registry.upsertAccount({ id: "icloud", ownerId: "owner", source: "icloud", displayName: "iCloud", status: "connected" });
  registry.upsertCalendar({ id: "cal", accountId: "icloud", sourceCalendarId: "home", name: "Ev", color: null, capabilities: { read: true, create: true, update: true, delete: true }, freshness: "fresh", sourceVersion: "1" });
  registry.upsertEvent({ id: "late", calendarId: "cal", sourceEventId: "late", sourceVersion: "1", eventJson: { title: "Later" }, startsAt: "2026-07-15T12:00:00.000Z", endsAt: "2026-07-15T13:00:00.000Z", freshness: "fresh" });
  registry.upsertEvent({ id: "early", calendarId: "cal", sourceEventId: "early", sourceVersion: "1", eventJson: { title: "Earlier" }, startsAt: "2026-07-15T10:00:00.000Z", endsAt: "2026-07-15T11:00:00.000Z", freshness: "fresh" });
  assert.equal(registry.listCalendars("owner").length, 1);
  assert.deepEqual(registry.listEvents("owner", "2026-07-15T09:00:00.000Z", "2026-07-15T14:00:00.000Z").map((event) => event.id), ["early", "late"]);
  store.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
