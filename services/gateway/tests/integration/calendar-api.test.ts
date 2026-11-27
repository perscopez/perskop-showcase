import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { CalendarRegistry } from "../../src/connectors/registry.js";
import { registerCalendarRoutes } from "../../src/api/calendarRoutes.js";
import crypto from "node:crypto";
import { IcloudCaldavClient } from "../../src/connectors/icloud/caldav.js";
import { GoogleCalendarClient } from "../../src/connectors/google/calendar.js";

test("calendar API is authenticated and returns owner-scoped events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-api-"));
  const memory = new MemoryStore(dir);
  const registry = new CalendarRegistry(memory.db);
  registry.upsertAccount({ id: "icloud", ownerId: "owner", source: "icloud", displayName: "iCloud", status: "connected" });
  registry.upsertCalendar({ id: "c", accountId: "icloud", sourceCalendarId: "home", name: "Ev", color: null, capabilities: { read: true, create: true, update: true, delete: true }, freshness: "fresh", sourceVersion: null });
  registry.upsertEvent({ id: "e", calendarId: "c", sourceEventId: "e", sourceVersion: null, eventJson: { title: "Test" }, startsAt: "2026-07-15T10:00:00.000Z", endsAt: "2026-07-15T11:00:00.000Z", freshness: "fresh" });
  const app = Fastify();
  registerCalendarRoutes(app, async (request, reply) => request.headers.authorization === "Bearer token" ? undefined : reply.code(401).send({ error: "unauthorized" }), memory);
  assert.equal((await app.inject({ method: "GET", url: "/api/calendar/calendars" })).statusCode, 401);
  const response = await app.inject({ method: "GET", url: "/api/calendar/events?start=2026-07-15T00%3A00%3A00.000Z&end=2026-07-16T00%3A00%3A00.000Z", headers: { authorization: "Bearer token" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].title, "Test");
  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("calendar mutations create an idempotent exact-approval proposal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-operation-")); const memory = new MemoryStore(dir); const app = Fastify();
  const registry = new CalendarRegistry(memory.db);
  registry.upsertAccount({ id: "icloud", ownerId: "owner", source: "icloud", displayName: "iCloud", status: "connected" });
  registerCalendarRoutes(app, async () => undefined, memory);
  const mutation = { schemaVersion: 1, action: "create", accountId: "icloud", calendarId: "calendar", title: "Ders", startAt: "2026-07-15T10:00:00.000Z", endAt: "2026-07-15T11:00:00.000Z", timezone: "Europe/Istanbul", allDay: false, idempotencyKey: "create-ders-once" };
  const first = await app.inject({ method: "POST", url: "/api/calendar/operations", payload: mutation }); assert.equal(first.statusCode, 200); assert.ok(first.json().approvalId); assert.equal(first.json().status, "pending");
  const second = await app.inject({ method: "POST", url: "/api/calendar/operations", payload: mutation }); assert.equal(second.statusCode, 200); assert.equal(second.json().replay, true); assert.equal(second.json().operationId, first.json().operationId);
  const operation = await app.inject({ method: "GET", url: `/api/calendar/operations/${first.json().operationId}` }); assert.equal(operation.json().item.status, "pending");
  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("iCloud connector setup encrypts credentials and starts first sync", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-setup-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const fakeClient = { discover: async () => ({ principalUrl: "p", calendarHomeUrl: "h", calendars: [] }), queryEvents: async () => [] } as unknown as IcloudCaldavClient;
  registerCalendarRoutes(app, async () => undefined, memory, { masterKey, icloudClientFactory: () => fakeClient });
  const response = await app.inject({ method: "POST", url: "/api/calendar/connectors/icloud", payload: { email: "owner@example.com", appSpecificPassword: "super-secret-password", displayName: "My iCloud" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("super-secret-password"), false);
  const raw = JSON.stringify(memory.db.prepare("SELECT * FROM connector_secrets").all());
  assert.equal(raw.includes("super-secret-password"), false);
  assert.equal(response.json().sync.status, "synced");
  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("Google OAuth callback stores credentials encrypted, syncs, and cannot replay state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-google-calendar-api-"));
  const memory = new MemoryStore(dir); const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const fakeGoogleClient = {
    listCalendars: async () => [{ id: "primary", summary: "My calendar", accessRole: "owner" }],
    listEvents: async () => ({ items: [{ id: "event", summary: "Sınav", start: { dateTime: "2026-07-15T10:00:00.000Z" }, end: { dateTime: "2026-07-15T11:00:00.000Z" } }], nextSyncToken: "sync" }),
  } as unknown as GoogleCalendarClient;
  registerCalendarRoutes(app, async () => undefined, memory, {
    masterKey,
    googleOAuth: { clientId: "client", clientSecret: "secret", redirectUri: "https://perskop.example/callback" },
    exchangeGoogleAuthorizationCode: (async ({ code }) => { assert.equal(code, "authorization-code"); return { access_token: "access-token", refresh_token: "refresh-token" }; }) as any,
    googleClientFactory: () => fakeGoogleClient,
  });
  const start = await app.inject({ method: "POST", url: "/api/calendar/connectors/google/oauth/start", payload: { displayName: "Gmail" } });
  assert.equal(start.statusCode, 200); const authorizationUrl = new URL(start.json().authorizationUrl); const state = authorizationUrl.searchParams.get("state")!;
  assert.equal(start.body.includes("secret"), false);
  const callback = await app.inject({ method: "GET", url: `/api/calendar/connectors/google/oauth/callback?state=${encodeURIComponent(state)}&code=authorization-code` });
  assert.equal(callback.statusCode, 200); assert.equal(callback.body.includes("access-token"), false); assert.equal(callback.json().sync.eventCount, 1);
  const raw = JSON.stringify(memory.db.prepare("SELECT * FROM connector_secrets").all());
  assert.equal(raw.includes("access-token"), false); assert.equal(raw.includes("refresh-token"), false);
  const replay = await app.inject({ method: "GET", url: `/api/calendar/connectors/google/oauth/callback?state=${encodeURIComponent(state)}&code=authorization-code` });
  assert.equal(replay.statusCode, 400);
  await app.close(); memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
