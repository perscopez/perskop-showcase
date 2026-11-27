import test from "node:test";
import assert from "node:assert/strict";
import { IcloudCaldavClient } from "../../src/connectors/icloud/caldav.js";
import { syncIcloudAccount } from "../../src/connectors/icloud/caldav.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";
import { MemoryStore } from "../../src/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const multistatus = (inner: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${inner}</d:multistatus>`;

test("iCloud CalDAV discovers principal, home and calendars", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    multistatus(`<d:response><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`),
    multistatus(`<d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`),
    multistatus(`<d:response><d:href>/123/calendars/work/</d:href><d:propstat><d:prop><d:displayname>İş</d:displayname><cs:getctag>v7</cs:getctag><d:resourcetype><d:collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response>`),
  ];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(responses.shift(), { status: 207 });
  };
  const client = new IcloudCaldavClient({ username: "owner@example.com", appSpecificPassword: "abcd-efgh", fetch: fakeFetch as typeof fetch });
  const result = await client.discover();
  assert.equal(result.principalUrl, "https://caldav.icloud.com/123/principal/");
  assert.equal(result.calendarHomeUrl, "https://caldav.icloud.com/123/calendars/");
  assert.deepEqual(result.calendars, [{ url: "https://caldav.icloud.com/123/calendars/work/", name: "İş", writable: true, sourceVersion: "v7" }]);
  assert.deepEqual(calls.map((call) => call.init?.method), ["PROPFIND", "PROPFIND", "PROPFIND"]);
  assert.equal(calls[2]?.init?.headers && new Headers(calls[2].init.headers).get("Depth"), "1");
});

test("iCloud CalDAV redacts credentials from failures", async () => {
  const client = new IcloudCaldavClient({ username: "owner@example.com", appSpecificPassword: "secret-password", fetch: (async () => new Response("denied", { status: 401 })) as typeof fetch });
  await assert.rejects(client.discover(), (error: Error) => error.message === "iCloud CalDAV authentication failed");
});

test("iCloud CalDAV queries ranges and binds writes to source versions", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(init?.method === "REPORT" ? multistatus(`<d:response><d:href>/event.ics</d:href><d:propstat><d:prop><d:getetag>\"v1\"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>`) : null, { status: init?.method === "REPORT" ? 207 : 204, headers: { ETag: '"v2"' } });
  };
  const client = new IcloudCaldavClient({ username: "owner@example.com", appSpecificPassword: "app-pass", fetch: fakeFetch as typeof fetch });
  const items = await client.queryEvents("https://caldav.icloud.com/home/", new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
  assert.equal(items[0]?.etag, '"v1"');
  assert.match(String(calls[0]?.init?.body), /time-range start="20260101T000000Z" end="20260201T000000Z"/);
  await client.putEvent("https://caldav.icloud.com/home/event.ics", "BEGIN:VCALENDAR\nEND:VCALENDAR", '"v1"');
  assert.equal(new Headers(calls[1]?.init?.headers).get("If-Match"), '"v1"');
  await client.deleteEvent("https://caldav.icloud.com/home/event.ics", '"v2"');
  assert.equal(new Headers(calls[2]?.init?.headers).get("If-Match"), '"v2"');
});

test("iCloud sync materializes discovered calendars and normalized events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-icloud-sync-"));
  const memory = new MemoryStore(dir);
  const registry = new CalendarRegistry(memory.db);
  const client = {
    discover: async () => ({ principalUrl: "p", calendarHomeUrl: "h", calendars: [{ url: "https://caldav.icloud.com/home/work/", name: "Derslerim", writable: true, sourceVersion: "c1" }] }),
    queryEvents: async () => [{ url: "event.ics", etag: '"e1"', data: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:lesson\nSUMMARY:Almanca\nDTSTART:20260715T110000Z\nDTEND:20260715T120000Z\nEND:VEVENT\nEND:VCALENDAR" }],
  } as unknown as IcloudCaldavClient;
  const result = await syncIcloudAccount({ registry, client, accountId: "icloud-owner", ownerId: "owner", displayName: "iCloud", start: new Date("2026-01-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") });
  assert.deepEqual({ calendars: result.calendarCount, events: result.eventCount }, { calendars: 1, events: 1 });
  assert.equal(registry.listEvents("owner", "2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z")[0]?.title, "Almanca");
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
