import test from "node:test";
import assert from "node:assert/strict";
import { GoogleCalendarClient } from "../../src/connectors/google/calendar.js";
import { syncGoogleAccount } from "../../src/connectors/google/calendar.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";
import { MemoryStore } from "../../src/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Google Calendar paginates calendars and events", async () => {
  const urls: string[] = [];
  const responses = [
    { items: [{ id: "a" }], nextPageToken: "p2" }, { items: [{ id: "b" }] },
    { items: [{ id: "e1" }], nextPageToken: "e2" }, { items: [{ id: "e2" }], nextSyncToken: "sync-1" },
  ];
  const client = new GoogleCalendarClient({ accessToken: "token", fetch: (async (url: URL | RequestInfo) => { urls.push(String(url)); return Response.json(responses.shift()); }) as typeof fetch });
  assert.deepEqual((await client.listCalendars()).map((item) => item.id), ["a", "b"]);
  const events = await client.listEvents({ calendarId: "primary", start: new Date("2026-01-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") });
  assert.deepEqual(events.items.map((item) => item.id), ["e1", "e2"]); assert.equal(events.nextSyncToken, "sync-1");
  assert.match(urls[3]!, /pageToken=e2/);
});

test("Google incremental sync never mixes syncToken with time bounds", async () => {
  let called = "";
  const client = new GoogleCalendarClient({ accessToken: "token", fetch: (async (url: URL | RequestInfo) => { called = String(url); return Response.json({ items: [], nextSyncToken: "next" }); }) as typeof fetch });
  await client.listEvents({ calendarId: "x", syncToken: "old", start: new Date(), end: new Date() });
  assert.match(called, /syncToken=old/); assert.doesNotMatch(called, /timeMin|timeMax|orderBy/);
});

test("Google sync materializes writable calendars and events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-google-sync-")); const memory = new MemoryStore(dir); const registry = new CalendarRegistry(memory.db);
  const client = {
    listCalendars: async () => [{ id: "primary", summary: "Gmail", accessRole: "owner", etag: "c1" }],
    listEvents: async () => ({ items: [{ id: "event", etag: "e1", summary: "Sınav", start: { dateTime: "2026-07-15T10:00:00Z" }, end: { dateTime: "2026-07-15T11:00:00Z" } }], nextSyncToken: "s1" }),
  } as unknown as GoogleCalendarClient;
  const result = await syncGoogleAccount({ registry, client, accountId: "google-owner", ownerId: "owner", displayName: "Gmail" });
  assert.deepEqual({ calendars: result.calendarCount, events: result.eventCount }, { calendars: 1, events: 1 });
  assert.equal(registry.listCalendars("owner")[0]?.capabilities.create, true); assert.equal(registry.listEvents("owner", "2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z")[0]?.title, "Sınav");
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
