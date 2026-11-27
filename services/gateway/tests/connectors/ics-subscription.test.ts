import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";
import { syncIcsSubscription } from "../../src/connectors/subscriptions/ics.js";

test("ICS subscriptions materialize as read-only calendars", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-ics-")); const memory = new MemoryStore(dir); const registry = new CalendarRegistry(memory.db);
  const body = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:holiday\nSUMMARY:Tatil\nDTSTART;VALUE=DATE:20260720\nDTEND;VALUE=DATE:20260721\nEND:VEVENT\nEND:VCALENDAR";
  await syncIcsSubscription({ registry, ownerId: "owner", accountId: "ics-holidays", name: "Tatiller", url: "https://example.com/holidays.ics", fetch: (async () => new Response(body, { status: 200, headers: { ETag: '"v1"' } })) as typeof fetch });
  const calendar = registry.listCalendars("owner")[0];
  assert.equal(calendar?.capabilities.read, true); assert.equal(calendar?.capabilities.create, false);
  assert.equal(registry.listEvents("owner", "2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z")[0]?.title, "Tatil");
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("ICS subscriptions reject insecure URLs", async () => {
  await assert.rejects(syncIcsSubscription({ registry: {} as CalendarRegistry, ownerId: "owner", accountId: "x", name: "x", url: "http://example.com/a.ics" }), /HTTPS/);
});
