import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { sendOAuthSuccess } from "./oauthResponse.js";
import { CalendarRegistry } from "../connectors/registry.js";
import type { MemoryStore } from "../db.js";
import { ConnectorSecretStore } from "../connectors/secretStore.js";
import { IcloudCaldavClient, syncIcloudAccount } from "../connectors/icloud/caldav.js";
import { GoogleCalendarApiError, GoogleCalendarClient, syncGoogleAccount } from "../connectors/google/calendar.js";
import { createGoogleOAuthRequest, exchangeGoogleAuthorizationCode, refreshGoogleAccessToken, GoogleOAuthStateStore } from "../connectors/google/oauth.js";
import { calendarMutationSchema, canonicalCalendarApproval, hashCalendarApproval } from "../security/calendarApproval.js";
import crypto from "node:crypto";
import { TaskService, type TaskTransitionFields } from "../tasks/taskService.js";
import type { TaskStatus } from "../tasks/stateMachine.js";

const rangeQuery = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
}).refine((value) => value.start < value.end, "start must be before end");

const GOOGLE_OAUTH_CONFIG_ACCOUNT_ID = "google_oauth_config";

export function registerCalendarRoutes(
  app: FastifyInstance,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  memory: MemoryStore,
  options: {
    masterKey?: string;
    icloudClientFactory?: (input: { username: string; appSpecificPassword: string }) => IcloudCaldavClient;
    googleOAuth?: { clientId: string; clientSecret: string; redirectUri: string };
    exchangeGoogleAuthorizationCode?: typeof exchangeGoogleAuthorizationCode;
    googleClientFactory?: (input: { accessToken: string }) => GoogleCalendarClient;
  } = {},
) {
  const registry = new CalendarRegistry(memory.db);
  const taskService = new TaskService(memory);
  const transitionTask = (taskId: number, to: TaskStatus, fields?: TaskTransitionFields) => {
    const row = memory.db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId) as { revision: number } | undefined;
    if (!row) throw new Error("task_not_found");
    return taskService.transition(taskId, { to, expectedRevision: row.revision, fields });
  };
  const getGoogleOAuthConfig = () => {
    if (options.googleOAuth) return options.googleOAuth;
    if (!options.masterKey) return null;
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    const clientId = secrets.get(GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_id");
    const clientSecret = secrets.get(GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_secret");
    const redirectUri = secrets.get(GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_redirect_uri");
    if (!clientId || !clientSecret || !redirectUri) return null;
    return { clientId, clientSecret, redirectUri };
  };

  app.get("/api/calendar/calendars", { preHandler: auth }, async () => ({ items: registry.listCalendars("owner") }));
  app.get("/api/calendar/events", { preHandler: auth }, async (request) => {
    const query = rangeQuery.parse(request.query);
    return { items: registry.listEvents("owner", query.start, query.end) };
});

function icalEscape(value: string) { return value.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n"); }
function toIcalDate(value: string) { return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function makeIcal(input: { uid: string; title: string; notes?: string | null; location?: string | null; startAt: string; endAt: string; timezone?: string }) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Perskop//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:${icalEscape(input.uid)}\r\nDTSTAMP:${toIcalDate(new Date().toISOString())}\r\nDTSTART:${toIcalDate(input.startAt)}\r\nDTEND:${toIcalDate(input.endAt)}\r\nSUMMARY:${icalEscape(input.title)}\r\n${input.notes ? `DESCRIPTION:${icalEscape(input.notes)}\r\n` : ""}${input.location ? `LOCATION:${icalEscape(input.location)}\r\n` : ""}END:VEVENT\r\nEND:VCALENDAR\r\n`;
}

  app.post("/api/calendar/operations", { preHandler: auth }, async (request) => {
    const mutation = calendarMutationSchema.parse(request.body);
    const existing = memory.db.prepare("SELECT operation_id FROM calendar_idempotency WHERE account_id=? AND idempotency_key=?").get(mutation.accountId, mutation.idempotencyKey) as { operation_id?: string } | undefined;
    if (existing?.operation_id) return { ok: true, operationId: existing.operation_id, status: "pending", replay: true };
    const taskId = memory.addTask({ source: "mac", prompt: `Calendar ${mutation.action}: ${mutation.title ?? mutation.eventId ?? "event"}`, workload: "calendar_write", proposed_operation: JSON.stringify(mutation), status: "waiting_approval" });
    const nonce = crypto.randomBytes(24).toString("base64url"); const canonicalPayload = canonicalCalendarApproval({ taskId, nonce, mutation }); const payloadHash = hashCalendarApproval(canonicalPayload);
    const approvalId = `calendar-${crypto.randomBytes(12).toString("hex")}`; const operationId = `calendar-op-${crypto.randomBytes(12).toString("hex")}`; const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    memory.createApproval({ id: approvalId, taskId, requestedBy: "owner", channelId: "calendar", sessionId: "calendar", operationType: "calendar_write", canonicalPayload, payloadHash, expiresAt, nonce });
    memory.db.prepare("UPDATE tasks SET approval_id=? WHERE id=?").run(approvalId, taskId);
    memory.db.prepare("INSERT INTO calendar_operations (id,account_id,operation_type,canonical_payload,payload_hash,status,source_version) VALUES (?,?,?,?,?,?,?)").run(operationId, mutation.accountId, mutation.action, canonicalPayload, payloadHash, "pending", mutation.sourceVersion ?? null);
    memory.db.prepare("INSERT INTO calendar_idempotency (account_id,idempotency_key,operation_id) VALUES (?,?,?)").run(mutation.accountId, mutation.idempotencyKey, operationId);
    return { ok: true, operationId, approvalId, status: "pending", expiresAt, payloadHash };
  });

  app.get("/api/calendar/operations", { preHandler: auth }, async () => {
    const items = memory.db.prepare(`SELECT o.id,o.account_id,o.operation_type,o.status,o.source_version,o.created_at,o.completed_at,a.id AS approval_id,a.status AS approval_status,a.expires_at FROM calendar_operations o LEFT JOIN approvals a ON a.payload_hash=o.payload_hash ORDER BY o.created_at DESC LIMIT 100`).all();
    return { items };
  });

  app.get("/api/calendar/operations/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string }; const row = memory.db.prepare("SELECT id,account_id,operation_type,status,source_version,created_at,completed_at FROM calendar_operations WHERE id=?").get(id);
    if (!row) return reply.code(404).send({ error: "calendar_operation_not_found" });
    return { item: row };
  });

  app.post("/api/calendar/operations/:id/execute", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const operation = memory.db.prepare("SELECT * FROM calendar_operations WHERE id=?").get(id) as { id: string; account_id: string; operation_type: string; canonical_payload: string; payload_hash: string; status: string } | undefined;
    if (!operation) return reply.code(404).send({ error: "calendar_operation_not_found" });
    const approval = memory.db.prepare("SELECT a.* FROM approvals a JOIN tasks t ON t.approval_id=a.id WHERE t.proposed_operation IS NOT NULL AND a.operation_type='calendar_write' AND a.payload_hash=?").get(operation.payload_hash) as { id: string; task_id: number; status: string; expires_at: string } | undefined;
    if (!approval || approval.status !== "approved" || new Date(approval.expires_at).getTime() <= Date.now()) return reply.code(409).send({ error: "calendar_operation_requires_approval" });
    if (!["pending", "approved"].includes(operation.status)) return reply.code(409).send({ error: "calendar_operation_not_pending" });
    if (!options.masterKey) return reply.code(503).send({ error: "connector encryption is not configured" });
    const taskOperation = memory.db.prepare("SELECT proposed_operation FROM tasks WHERE approval_id=?").get(approval.id) as { proposed_operation: string } | undefined;
    if (!taskOperation?.proposed_operation) return reply.code(409).send({ error: "calendar_operation_payload_missing" });
    const mutation = JSON.parse(taskOperation.proposed_operation);
    const calendar = memory.db.prepare("SELECT source_calendar_id FROM calendar_calendars WHERE id=? AND account_id=?").get(mutation.calendarId, mutation.accountId) as { source_calendar_id?: string } | undefined;
    const account = memory.db.prepare("SELECT source FROM connector_accounts WHERE id=?").get(mutation.accountId) as { source?: string } | undefined;
    if (!calendar || !account?.source || !["google", "icloud"].includes(account.source)) return reply.code(409).send({ error: "calendar_provider_write_not_supported" });
    const existing = mutation.eventId ? memory.db.prepare("SELECT source_event_id,event_json FROM calendar_events WHERE id=?").get(mutation.eventId) as { source_event_id: string; event_json: string } | undefined : undefined;
    const providerEventId = existing?.source_event_id ?? mutation.eventId;
    if (mutation.action !== "create" && !providerEventId) return reply.code(409).send({ error: "calendar_event_not_found" });
    if (account.source === "icloud") {
      const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
      const username = secrets.get(mutation.accountId, "icloud_username"); const password = secrets.get(mutation.accountId, "icloud_app_password");
      if (!username || !password) return reply.code(409).send({ error: "calendar_connector_needs_reauth" });
      transitionTask(approval.task_id, "running");
      const client = options.icloudClientFactory?.({ username, appSpecificPassword: password }) ?? new IcloudCaldavClient({ username, appSpecificPassword: password });
      const eventJson = existing ? JSON.parse(eventJsonSafe(existing.event_json)) : undefined;
      const sourceUrl = eventJson?.sourceUrl ?? `${calendar.source_calendar_id!.replace(/\/$/, "")}/${encodeURIComponent(providerEventId ?? crypto.randomUUID())}.ics`;
      try {
        if (mutation.action === "delete") await client.deleteEvent(sourceUrl, mutation.sourceVersion ?? "*");
        else await client.putEvent(sourceUrl, makeIcal({ uid: existing?.source_event_id ?? crypto.randomUUID(), title: mutation.title!, notes: mutation.notes, location: mutation.location, startAt: mutation.startAt!, endAt: mutation.endAt!, timezone: mutation.timezone }), mutation.sourceVersion);
        memory.db.prepare("UPDATE calendar_operations SET status='succeeded',completed_at=datetime('now') WHERE id=?").run(id); memory.setApprovalStatus(approval.id, "consumed");
        transitionTask(approval.task_id, "succeeded", { response: `Calendar operation succeeded: ${id}`, provider: "icloud" });
        return { ok: true, operationId: id, status: "succeeded" };
      } catch (error) { memory.db.prepare("UPDATE calendar_operations SET status='failed',completed_at=datetime('now') WHERE id=?").run(id); transitionTask(approval.task_id, "failed", { error: "calendar_operation_failed" }); request.log.warn({ err: error, operationId: id }, "iCloud calendar operation failed"); return reply.code(502).send({ error: "calendar_operation_failed" }); }
    }
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    let accessToken = secrets.get(mutation.accountId, "google_access_token");
    const expiresAt = Number(secrets.get(mutation.accountId, "google_access_expires_at") ?? 0);
    const googleOAuth = getGoogleOAuthConfig();
    if (googleOAuth && expiresAt > 0 && expiresAt <= Date.now() + 30_000) {
      const refreshToken = secrets.get(mutation.accountId, "google_refresh_token");
      if (refreshToken) {
        const refreshed = await refreshGoogleAccessToken({ ...googleOAuth, refreshToken });
        accessToken = refreshed.access_token; secrets.put({ accountId: mutation.accountId, kind: "google_access_token", value: accessToken });
        if (refreshed.expires_in) secrets.put({ accountId: mutation.accountId, kind: "google_access_expires_at", value: String(Date.now() + refreshed.expires_in * 1000) });
      }
    }
    if (!accessToken) return reply.code(409).send({ error: "calendar_connector_needs_reauth" });
    transitionTask(approval.task_id, "running");
    const client = options.googleClientFactory?.({ accessToken }) ?? new GoogleCalendarClient({ accessToken });
    const event = { summary: mutation.title, description: mutation.notes ?? undefined, location: mutation.location ?? undefined, start: mutation.allDay ? { date: mutation.startAt.slice(0, 10) } : { dateTime: mutation.startAt, timeZone: mutation.timezone }, end: mutation.allDay ? { date: mutation.endAt.slice(0, 10) } : { dateTime: mutation.endAt, timeZone: mutation.timezone }, recurrence: mutation.recurrenceRule ? mutation.recurrenceRule.split("\n") : undefined };
    try {
      let result: unknown;
      if (mutation.action === "create") result = await client.createEvent({ calendarId: calendar.source_calendar_id!, event });
      else if (mutation.action === "update" || mutation.action === "move") result = await client.updateEvent({ calendarId: calendar.source_calendar_id!, eventId: providerEventId!, event, sourceVersion: mutation.sourceVersion });
      else { await client.deleteEvent({ calendarId: calendar.source_calendar_id!, eventId: providerEventId!, sourceVersion: mutation.sourceVersion }); result = null; }
      memory.db.prepare("UPDATE calendar_operations SET status='succeeded',completed_at=datetime('now') WHERE id=?").run(id); memory.setApprovalStatus(approval.id, "consumed");
      transitionTask(approval.task_id, "succeeded", { response: `Calendar operation succeeded: ${id}`, provider: "google_calendar" });
      return { ok: true, operationId: id, status: "succeeded", result };
    } catch (error) {
      memory.db.prepare("UPDATE calendar_operations SET status='failed',completed_at=datetime('now') WHERE id=?").run(id);
      transitionTask(approval.task_id, "failed", { error: "calendar_operation_failed" });
      request.log.warn({ err: error, operationId: id }, "Calendar operation execution failed");
      return reply.code(502).send({ error: "calendar_operation_failed" });
    }
  });

  app.post("/api/calendar/connectors/icloud", { preHandler: auth }, async (request, reply) => {
    if (!options.masterKey) return reply.code(503).send({ error: "connector encryption is not configured" });
    const body = z.object({ email: z.string().email(), appSpecificPassword: z.string().min(8), displayName: z.string().min(1).max(100).default("iCloud") }).parse(request.body);
    const accountId = `icloud_${crypto.createHash("sha256").update(body.email.toLowerCase()).digest("hex").slice(0, 24)}`;
    registry.upsertAccount({ id: accountId, ownerId: "owner", source: "icloud", displayName: body.displayName, status: "connected" });
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    secrets.put({ accountId, kind: "icloud_username", value: body.email });
    secrets.put({ accountId, kind: "icloud_app_password", value: body.appSpecificPassword });
    const client = options.icloudClientFactory?.({ username: body.email, appSpecificPassword: body.appSpecificPassword }) ?? new IcloudCaldavClient({ username: body.email, appSpecificPassword: body.appSpecificPassword });
    const sync = await syncIcloudAccount({ registry, client, accountId, ownerId: "owner", displayName: body.displayName });
    return { ok: true, accountId, sync };
  });

  app.get("/api/calendar/connectors/google/oauth/status", { preHandler: auth }, async () => {
    return { configured: Boolean(getGoogleOAuthConfig()) };
  });

  app.post("/api/calendar/connectors/google/oauth/config", { preHandler: auth }, async (request, reply) => {
    if (!options.masterKey) return reply.code(503).send({ error: "connector encryption is not configured" });
    const parsed = z.object({
      clientId: z.string().min(20),
      clientSecret: z.string().min(8),
      redirectUri: z.string().url(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "google_oauth_config_required" });
    const body = parsed.data;
    registry.upsertAccount({ id: GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, ownerId: "owner", source: "google", displayName: "Google OAuth", status: "connected" });
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    secrets.put({ accountId: GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_client_id", value: body.clientId });
    secrets.put({ accountId: GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_client_secret", value: body.clientSecret });
    secrets.put({ accountId: GOOGLE_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_redirect_uri", value: body.redirectUri });
    return { ok: true, configured: true };
  });

  const googleErrorPayload = (error: unknown) => {
    if (error instanceof GoogleCalendarApiError) return { status: error.status, reason: error.reason, message: error.providerMessage };
    return undefined;
  };

  const googleUserError = (error: unknown) => {
    if (!(error instanceof GoogleCalendarApiError)) return "Google Calendar connection could not be completed";
    if (error.reason === "accessNotConfigured" || error.reason === "SERVICE_DISABLED") return "Google Calendar API is not enabled for this Google project";
    if (error.reason === "insufficientPermissions" || error.status === 401 || error.status === 403) return "Google Calendar permission was not granted";
    return "Google Calendar connection could not be completed";
  };

  const syncExistingGoogleAccount = async (accountId: string, displayName: string) => {
    if (!options.masterKey) throw new Error("connector encryption is not configured");
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    let accessToken = secrets.get(accountId, "google_access_token");
    const expiresAt = Number(secrets.get(accountId, "google_access_expires_at") ?? 0);
    const googleOAuth = getGoogleOAuthConfig();
    if (googleOAuth && expiresAt > 0 && expiresAt <= Date.now() + 30_000) {
      const refreshToken = secrets.get(accountId, "google_refresh_token");
      if (refreshToken) {
        const refreshed = await refreshGoogleAccessToken({ ...googleOAuth, refreshToken });
        accessToken = refreshed.access_token; secrets.put({ accountId, kind: "google_access_token", value: accessToken });
        if (refreshed.expires_in) secrets.put({ accountId, kind: "google_access_expires_at", value: String(Date.now() + refreshed.expires_in * 1000) });
      }
    }
    if (!accessToken) throw new Error("calendar_connector_needs_reauth");
    const client = options.googleClientFactory?.({ accessToken }) ?? new GoogleCalendarClient({ accessToken });
    return syncGoogleAccount({ registry, client, accountId, ownerId: "owner", displayName });
  };

  app.post("/api/calendar/connectors/google/sync", { preHandler: auth }, async (_request, reply) => {
    const account = memory.db.prepare("SELECT id,display_name FROM connector_accounts WHERE source='google' AND id != ? ORDER BY updated_at DESC LIMIT 1").get(GOOGLE_OAUTH_CONFIG_ACCOUNT_ID) as { id: string; display_name?: string } | undefined;
    if (!account) return reply.code(404).send({ error: "google_calendar_account_not_found" });
    try {
      const sync = await syncExistingGoogleAccount(account.id, account.display_name ?? "Google Calendar");
      return { ok: true, accountId: account.id, sync };
    } catch (error) {
      registry.upsertAccount({ id: account.id, ownerId: "owner", source: "google", displayName: account.display_name ?? "Google Calendar", status: "error" });
      _request.log.warn({ err: error, accountId: account.id, google: googleErrorPayload(error) }, "Google Calendar sync failed");
      return reply.code(502).send({ error: googleUserError(error), google: googleErrorPayload(error) });
    }
  });

  app.post("/api/calendar/connectors/google/oauth/start", { preHandler: auth }, async (request, reply) => {
    const googleOAuth = getGoogleOAuthConfig();
    if (!options.masterKey || !googleOAuth) return reply.code(503).send({ error: "Google Calendar connection is not configured" });
    const body = z.object({ displayName: z.string().min(1).max(100).default("Google Calendar") }).parse(request.body ?? {});
    const accountId = `google_${crypto.createHash("sha256").update("owner:google").digest("hex").slice(0, 24)}`;
    const oauth = createGoogleOAuthRequest({ clientId: googleOAuth.clientId, redirectUri: googleOAuth.redirectUri });
    registry.upsertAccount({ id: accountId, ownerId: "owner", source: "google", displayName: body.displayName, status: "needs_reauth" });
    new GoogleOAuthStateStore(memory.db, options.masterKey).save({ state: oauth.state, accountId, verifier: oauth.codeVerifier });
    return { ok: true, accountId, authorizationUrl: oauth.url };
  });

  app.get("/api/calendar/connectors/google/oauth/callback", async (request, reply) => {
    const googleOAuth = getGoogleOAuthConfig();
    if (!options.masterKey || !googleOAuth) return reply.code(503).send({ error: "Google Calendar connection is not configured" });
    const query = z.object({ state: z.string().min(20), code: z.string().min(1).optional(), error: z.string().optional() }).parse(request.query);
    if (query.error) return reply.code(400).send({ error: "Google Calendar authorization was not granted" });
    if (!query.code) return reply.code(400).send({ error: "Google Calendar authorization code is missing" });
    const pending = new GoogleOAuthStateStore(memory.db, options.masterKey).consume(query.state);
    if (!pending) {
      const pendingMail = new GoogleOAuthStateStore(memory.db, options.masterKey, "google_mail").consume(query.state);
      if (!pendingMail) return reply.code(400).send({ error: "Google authorization is invalid or expired" });
      try {
        const token = await (options.exchangeGoogleAuthorizationCode ?? exchangeGoogleAuthorizationCode)({ ...googleOAuth, code: query.code, codeVerifier: pendingMail.verifier });
        const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
        secrets.put({ accountId: pendingMail.accountId, kind: "google_access_token", value: token.access_token });
        if (token.expires_in) secrets.put({ accountId: pendingMail.accountId, kind: "google_access_expires_at", value: String(Date.now() + token.expires_in * 1000) });
        if (token.refresh_token) secrets.put({ accountId: pendingMail.accountId, kind: "google_refresh_token", value: token.refresh_token });
        memory.db.prepare("UPDATE connector_accounts SET status='connected',updated_at=datetime('now') WHERE id=? AND source='google_mail'").run(pendingMail.accountId);
        return sendOAuthSuccess(request, reply, { connector: "Gmail", payload: { ok: true, connector: "gmail", accountId: pendingMail.accountId, status: "connected" } });
      } catch (error) {
        memory.db.prepare("UPDATE connector_accounts SET status='error',updated_at=datetime('now') WHERE id=? AND source='google_mail'").run(pendingMail.accountId);
        request.log.warn({ err: error, accountId: pendingMail.accountId }, "Gmail OAuth completion through shared Google callback failed");
        return reply.code(502).send({ error: "Gmail connection could not be completed" });
      }
    }
    try {
      const token = await (options.exchangeGoogleAuthorizationCode ?? exchangeGoogleAuthorizationCode)({ ...googleOAuth, code: query.code, codeVerifier: pending.verifier });
      const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
      secrets.put({ accountId: pending.accountId, kind: "google_access_token", value: token.access_token });
      if (token.expires_in) secrets.put({ accountId: pending.accountId, kind: "google_access_expires_at", value: String(Date.now() + token.expires_in * 1000) });
      if (token.refresh_token) secrets.put({ accountId: pending.accountId, kind: "google_refresh_token", value: token.refresh_token });
      const client = options.googleClientFactory?.({ accessToken: token.access_token }) ?? new GoogleCalendarClient({ accessToken: token.access_token });
      const account = memory.db.prepare("SELECT display_name FROM connector_accounts WHERE id = ?").get(pending.accountId) as { display_name?: string } | undefined;
      const sync = await syncGoogleAccount({ registry, client, accountId: pending.accountId, ownerId: "owner", displayName: account?.display_name ?? "Google Calendar" });
      return sendOAuthSuccess(request, reply, { connector: "Google Calendar", payload: { ok: true, accountId: pending.accountId, sync } });
    } catch (error) {
      registry.upsertAccount({ id: pending.accountId, ownerId: "owner", source: "google", displayName: "Google Calendar", status: "error" });
      request.log.warn({ err: error, accountId: pending.accountId, google: googleErrorPayload(error) }, "Google Calendar OAuth completion failed");
      return reply.code(502).send({ error: googleUserError(error), google: googleErrorPayload(error) });
    }
  });
}

function eventJsonSafe(value: string) { return value; }
