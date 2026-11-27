import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { MemoryStore } from "../../src/db.js";
import { registerMailRoutes } from "../../src/api/mailRoutes.js";
import { registerCalendarRoutes } from "../../src/api/calendarRoutes.js";
import { ConnectorSecretStore } from "../../src/connectors/secretStore.js";
import { GmailApiError } from "../../src/connectors/google/gmail.js";
import { GmailStore } from "../../src/email/gmailStore.js";

const auth = async (request: any, reply: any) =>
  request.headers.authorization === "Bearer token"
    ? undefined
    : reply.code(401).send({ error: "unauthorized" });

test("Gmail OAuth config, grant and disconnect keep credentials encrypted and provider-scoped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-mail-api-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  registerMailRoutes(app, auth, memory, {
    masterKey,
    exchangeGoogleAuthorizationCode: (async ({ code }) => {
      assert.ok(["authorization-code", "browser-code"].includes(code));
      return { access_token: "mail-access-token", refresh_token: "mail-refresh-token", expires_in: 3600 };
    }) as any,
  });

  const unauthorized = await app.inject({ method: "GET", url: "/api/mail/connectors/google/oauth/status" });
  assert.equal(unauthorized.statusCode, 401);

  const configured = await app.inject({
    method: "POST",
    url: "/api/mail/connectors/google/oauth/config",
    headers: { authorization: "Bearer token" },
    payload: {
      clientId: "client-id-that-is-long-enough.apps.googleusercontent.com",
      clientSecret: "mail-client-secret",
      redirectUri: "https://perskop.example/api/mail/connectors/google/oauth/callback",
    },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.body.includes("mail-client-secret"), false);

  const start = await app.inject({
    method: "POST",
    url: "/api/mail/connectors/google/oauth/start",
    headers: { authorization: "Bearer token" },
    payload: { displayName: "Personal Gmail" },
  });
  assert.equal(start.statusCode, 200);
  const authorizationUrl = new URL(start.json().authorizationUrl);
  assert.match(authorizationUrl.searchParams.get("scope") ?? "", /gmail\.modify/);
  assert.equal(start.body.includes("mail-client-secret"), false);
  const state = authorizationUrl.searchParams.get("state")!;

  const callback = await app.inject({
    method: "GET",
    url: `/api/mail/connectors/google/oauth/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
  });
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.body.includes("mail-access-token"), false);
  assert.equal(callback.body.includes("mail-refresh-token"), false);
  assert.equal(callback.json().status, "connected");

  const status = await app.inject({
    method: "GET",
    url: "/api/mail/connectors/google/oauth/status",
    headers: { authorization: "Bearer token" },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, true);
  assert.equal(status.json().accounts[0].status, "connected");

  const raw = JSON.stringify(memory.db.prepare("SELECT * FROM connector_secrets").all());
  assert.equal(raw.includes("mail-client-secret"), false);
  assert.equal(raw.includes("mail-access-token"), false);
  assert.equal(raw.includes("mail-refresh-token"), false);

  const replay = await app.inject({
    method: "GET",
    url: `/api/mail/connectors/google/oauth/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
  });
  assert.equal(replay.statusCode, 400);

  const browserStart = await app.inject({
    method: "POST",
    url: "/api/mail/connectors/google/oauth/start",
    headers: { authorization: "Bearer token" },
    payload: { displayName: "Browser Gmail" },
  });
  const browserState = new URL(browserStart.json().authorizationUrl).searchParams.get("state")!;
  const browserCallback = await app.inject({
    method: "GET",
    url: `/api/mail/connectors/google/oauth/callback?state=${encodeURIComponent(browserState)}&code=browser-code`,
    headers: { accept: "text/html" },
  });
  assert.equal(browserCallback.statusCode, 200);
  assert.match(browserCallback.headers["content-type"] ?? "", /text\/html/);
  assert.match(browserCallback.body, /Gmail bağlandı/);
  assert.equal(browserCallback.body.includes("mail-access-token"), false);

  const disconnected = await app.inject({
    method: "POST",
    url: `/api/mail/accounts/${encodeURIComponent(callback.json().accountId)}/disconnect`,
    headers: { authorization: "Bearer token" },
  });
  assert.equal(disconnected.statusCode, 200);
  assert.equal(memory.db.prepare("SELECT COUNT(*) AS count FROM connector_secrets WHERE account_id=?").get(callback.json().accountId).count, 0);

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gmail sync distinguishes a disabled provider API from expired authorization", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-mail-api-disabled-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const accountId = "google_mail_disabled_api";
  memory.db.prepare(`
    INSERT INTO connector_accounts (id,owner_id,source,display_name,status)
    VALUES (?, 'owner', 'google_mail', 'Personal Gmail', 'connected')
  `).run(accountId);
  new ConnectorSecretStore(memory.db, masterKey).put({
    accountId,
    kind: "google_access_token",
    value: "mail-access-token",
  });
  registerMailRoutes(app, auth, memory, {
    masterKey,
    gmailClientFactory: () => ({
      getProfile: async () => {
        throw new GmailApiError(403, "accessNotConfigured", "Gmail API has not been used");
      },
    }) as any,
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/mail/accounts/${accountId}/sync`,
    headers: { authorization: "Bearer token" },
    payload: { maxThreads: 20 },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "gmail_api_not_enabled" });

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gmail reuses the registered Calendar OAuth client without mixing consent grants", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-shared-google-oauth-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  memory.db.prepare(`INSERT INTO connector_accounts (id,owner_id,source,display_name,status) VALUES ('google_oauth_config','owner','google','Google OAuth','connected')`).run();
  const secrets = new ConnectorSecretStore(memory.db, masterKey);
  secrets.put({ accountId: "google_oauth_config", kind: "google_oauth_client_id", value: "shared-client-id-that-is-long-enough.apps.googleusercontent.com" });
  secrets.put({ accountId: "google_oauth_config", kind: "google_oauth_client_secret", value: "shared-client-secret" });
  secrets.put({ accountId: "google_oauth_config", kind: "google_oauth_redirect_uri", value: "http://127.0.0.1:8787/api/calendar/connectors/google/oauth/callback" });
  registerMailRoutes(app, auth, memory, { masterKey });
  registerCalendarRoutes(app, auth, memory, {
    masterKey,
    exchangeGoogleAuthorizationCode: (async () => ({ access_token: "gmail-grant-token", refresh_token: "gmail-refresh-token", expires_in: 3600 })) as any,
  });
  const headers = { authorization: "Bearer token" };
  const status = await app.inject({ method: "GET", url: "/api/mail/connectors/google/oauth/status", headers });
  assert.equal(status.json().configured, true);
  const start = await app.inject({ method: "POST", url: "/api/mail/connectors/google/oauth/start", headers, payload: {} });
  const authorizationUrl = new URL(start.json().authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/api/calendar/connectors/google/oauth/callback");
  const callback = await app.inject({ method: "GET", url: `/api/calendar/connectors/google/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}&code=mail-code` });
  assert.equal(callback.statusCode, 200, callback.body);
  assert.equal(callback.json().connector, "gmail");
  assert.equal(memory.db.prepare("SELECT status FROM connector_accounts WHERE id=?").get(start.json().accountId).status, "connected");
  assert.equal(secrets.get(start.json().accountId, "google_access_token"), "gmail-grant-token");

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gmail inbox API isolates accounts, searches cached threads and mirrors reversible mutations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-mail-inbox-api-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const accountId = "google_mail_inbox";
  memory.db.prepare(`
    INSERT INTO connector_accounts (id,owner_id,source,display_name,status)
    VALUES (?, 'owner', 'google_mail', 'Personal Gmail', 'connected')
  `).run(accountId);
  new ConnectorSecretStore(memory.db, masterKey).put({ accountId, kind: "google_access_token", value: "access-token" });

  const labels = new Map<string, string[]>([
    ["priority", ["INBOX", "UNREAD"]],
    ["promo", ["INBOX", "CATEGORY_PROMOTIONS"]],
  ]);
  const thread = (id: string) => ({
    id,
    historyId: id === "priority" ? "101" : "102",
    snippet: id === "priority" ? "Application deadline" : "Half price sale",
    messages: [{
      id: `${id}-message`,
      threadId: id,
      internalDate: id === "priority" ? "1760000000000" : "1750000000000",
      snippet: id === "priority" ? "Submit before Friday" : "Buy now",
      labelIds: labels.get(id) ?? [],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: id === "priority" ? "Visa appointment action required" : "Weekend sale" },
          { name: "From", value: id === "priority" ? "TU Dortmund <study@tu-dortmund.de>" : "Shop <deals@example.com>" },
        ],
        parts: id === "priority" ? [{
          partId: "1",
          mimeType: "application/pdf",
          filename: "appointment.pdf",
          body: { attachmentId: "attachment-1", size: 321 },
        }] : [],
      },
    }],
  });
  const mutations: Array<{ id: string; add?: string[]; remove?: string[] }> = [];
  const fakeClient = {
    getProfile: async () => ({ emailAddress: "owner@example.com", messagesTotal: 2, threadsTotal: 2, historyId: "200" }),
    listLabels: async () => [
      { id: "INBOX", name: "Inbox", type: "system" },
      { id: "STARRED", name: "Starred", type: "system" },
    ],
    listThreads: async () => ({ threads: [{ id: "priority" }, { id: "promo" }], resultSizeEstimate: 2 }),
    getThread: async (id: string) => thread(id),
    getAttachment: async () => ({ data: Buffer.from("pdf"), size: 3 }),
    modifyThread: async (id: string, mutation: { addLabelIds?: string[]; removeLabelIds?: string[] }) => {
      const current = new Set(labels.get(id) ?? []);
      for (const value of mutation.addLabelIds ?? []) current.add(value);
      for (const value of mutation.removeLabelIds ?? []) current.delete(value);
      labels.set(id, [...current]);
      mutations.push({ id, add: mutation.addLabelIds, remove: mutation.removeLabelIds });
      return { id, labelIds: [...current] };
    },
    trashThread: async (id: string) => {
      labels.set(id, ["TRASH"]);
      return thread(id);
    },
    untrashThread: async (id: string) => {
      labels.set(id, ["INBOX"]);
      return thread(id);
    },
  };
  registerMailRoutes(app, auth, memory, {
    masterKey,
    gmailClientFactory: () => fakeClient as any,
  });

  const headers = { authorization: "Bearer token" };
  const unauthorized = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads` });
  assert.equal(unauthorized.statusCode, 401);

  const synced = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/sync`, headers, payload: { maxThreads: 25 } });
  assert.equal(synced.statusCode, 200, synced.body);
  assert.equal(synced.json().sync.threadCount, 2);

  const status = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/sync/status`, headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().emailAddress, "owner@example.com");

  const visible = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads`, headers });
  assert.equal(visible.statusCode, 200, visible.body);
  assert.deepEqual(visible.json().items.map((item: any) => item.threadId), ["priority"]);
  assert.equal(visible.json().items[0].category, "urgent");

  const all = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads?includeHidden=true&limit=1&offset=1`, headers });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().items[0].threadId, "promo");

  const searched = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads?q=appointment`, headers });
  assert.equal(searched.json().items.length, 1);
  const isolated = await app.inject({ method: "GET", url: "/api/mail/accounts/other/threads", headers });
  assert.equal(isolated.statusCode, 404);

  const detail = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads/priority`, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().item.messages.length, 1);
  const attachments = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/threads/priority/attachments`, headers });
  assert.equal(attachments.json().items[0].filename, "appointment.pdf");
  const attachment = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/messages/priority-message/attachments/attachment-1`, headers });
  assert.equal(attachment.json().data, Buffer.from("pdf").toString("base64"));

  const read = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "read" } });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().item.unread, false);
  const starred = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "star" } });
  assert.equal(starred.json().item.starred, true);
  const archived = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "archive" } });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().item.labelIds.includes("INBOX"), false);
  const customLabels = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "labels", addLabelIds: ["Label_1"], removeLabelIds: [] } });
  assert.equal(customLabels.json().item.labelIds.includes("Label_1"), true);
  const trashed = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "trash" } });
  assert.equal(trashed.json().item.labelIds.includes("TRASH"), true);
  const restored = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "restore" } });
  assert.equal(restored.json().item.labelIds.includes("INBOX"), true);
  assert.equal(mutations.length >= 4, true);

  const permanentDelete = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/threads/priority/mutate`, headers, payload: { action: "delete" } });
  assert.notEqual(permanentDelete.statusCode, 200);

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Gmail draft send requires current exact approval, expires, invalidates on edit and never double-sends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-mail-send-api-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const accountId = "google_mail_sender";
  memory.db.prepare(`
    INSERT INTO connector_accounts (id,owner_id,source,display_name,status)
    VALUES (?, 'owner', 'google_mail', 'Personal Gmail', 'connected')
  `).run(accountId);
  new ConnectorSecretStore(memory.db, masterKey).put({ accountId, kind: "google_access_token", value: "access-token" });
  const sent: Array<{ raw: string; threadId?: string | null }> = [];
  registerMailRoutes(app, auth, memory, {
    masterKey,
    gmailClientFactory: () => ({
      sendMessage: async (input: { raw: string; threadId?: string | null }) => {
        sent.push(input);
        return { id: `sent-${sent.length}`, threadId: input.threadId ?? "new-thread" };
      },
    }) as any,
  });
  const headers = { authorization: "Bearer token" };
  const draftPayload = {
    threadId: "thread-1",
    to: ["recipient@example.com"],
    cc: ["copy@example.com"],
    bcc: ["private@example.com"],
    subject: "Final subject",
    bodyText: "Exact final body",
    attachments: [{ filename: "proof.txt", mimeType: "text/plain", dataBase64: Buffer.from("proof").toString("base64") }],
  };
  const created = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts`, headers, payload: draftPayload });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.body.includes(draftPayload.attachments[0].dataBase64), false);
  const draftId = created.json().item.draftId;

  const propose = async () => app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts/${draftId}/propose-send`, headers });
  const first = await propose();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(new Date(first.json().expiresAt).getTime() - Date.now() > 29 * 60_000, true);
  const executeBeforeApproval = await app.inject({ method: "POST", url: `/api/mail/send-operations/${first.json().operationId}/execute`, headers });
  assert.equal(executeBeforeApproval.statusCode, 409);

  const editedPayload = { ...draftPayload, subject: "Edited subject", attachments: [] };
  const edited = await app.inject({ method: "PATCH", url: `/api/mail/accounts/${accountId}/drafts/${draftId}`, headers, payload: editedPayload });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().item.status, "draft");
  const approveInvalidated = await app.inject({ method: "POST", url: `/api/mail/send-operations/${first.json().operationId}/approve`, headers });
  assert.equal(approveInvalidated.statusCode, 409);

  const second = await propose();
  const secondId = second.json().operationId;
  const approvedSecond = await app.inject({ method: "POST", url: `/api/mail/send-operations/${secondId}/approve`, headers });
  assert.equal(approvedSecond.statusCode, 200, approvedSecond.body);
  await app.inject({ method: "PATCH", url: `/api/mail/accounts/${accountId}/drafts/${draftId}`, headers, payload: { ...editedPayload, bodyText: "Changed after approval" } });
  const executeInvalidated = await app.inject({ method: "POST", url: `/api/mail/send-operations/${secondId}/execute`, headers });
  assert.equal(executeInvalidated.statusCode, 409);
  assert.equal(sent.length, 0);

  const third = await propose();
  const thirdId = third.json().operationId;
  assert.equal((await app.inject({ method: "POST", url: `/api/mail/send-operations/${thirdId}/approve`, headers })).statusCode, 200);
  const executed = await app.inject({ method: "POST", url: `/api/mail/send-operations/${thirdId}/execute`, headers });
  assert.equal(executed.statusCode, 200, executed.body);
  assert.equal(executed.json().providerMessageId, "sent-1");
  assert.equal(sent.length, 1);
  const mime = Buffer.from(sent[0].raw, "base64url").toString("utf8");
  assert.match(mime, /To: recipient@example\.com/);
  assert.match(mime, /Q2hhbmdlZCBhZnRlciBhcHByb3ZhbA==/);
  const replay = await app.inject({ method: "POST", url: `/api/mail/send-operations/${thirdId}/execute`, headers });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replay, true);
  assert.equal(sent.length, 1);

  const otherDraft = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts`, headers, payload: { ...draftPayload, attachments: [] } });
  const expiringDraftId = otherDraft.json().item.draftId;
  const expiring = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts/${expiringDraftId}/propose-send`, headers });
  memory.db.prepare("UPDATE approvals SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), expiring.json().approvalId);
  const expired = await app.inject({ method: "POST", url: `/api/mail/send-operations/${expiring.json().operationId}/approve`, headers });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().error, "email_send_approval_expired");

  const rejectDraft = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts`, headers, payload: { ...draftPayload, attachments: [] } });
  const rejection = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/drafts/${rejectDraft.json().item.draftId}/propose-send`, headers });
  const rejected = await app.inject({ method: "POST", url: `/api/mail/send-operations/${rejection.json().operationId}/reject`, headers });
  assert.equal(rejected.json().status, "rejected");
  assert.equal(sent.length, 1);

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unsubscribe batches require exact selection approval and report partial methods without replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-unsubscribe-api-"));
  const memory = new MemoryStore(dir);
  const app = Fastify();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const accountId = "google_mail_unsubscribe";
  memory.db.prepare(`INSERT INTO connector_accounts (id,owner_id,source,display_name,status) VALUES (?, 'owner', 'google_mail', 'Gmail', 'connected')`).run(accountId);
  new ConnectorSecretStore(memory.db, masterKey).put({ accountId, kind: "google_access_token", value: "access-token" });
  const store = new GmailStore(memory.db);
  const addThread = (id: string, sender: string, list: string, post = "") => store.upsertThread({
    accountId, threadId: id, historyId: "1", subject: "Promotion", from: sender, snippet: "sale", lastMessageAt: "2026-07-18T00:00:00.000Z", labelIds: ["CATEGORY_PROMOTIONS"], unread: false, starred: false, hidden: true, category: "promotion", score: -10, reasons: ["promotion"],
    messages: [{ messageId: `${id}-message`, threadId: id, rfcMessageId: null, internalDate: "2026-07-18T00:00:00.000Z", subject: "Promotion", from: sender, snippet: "sale", labelIds: [], bodyText: "", payload: { headers: [{ name: "List-Unsubscribe", value: list }, { name: "List-Unsubscribe-Post", value: post }] } }],
  });
  addThread("one-click", "Shop <shop@example.com>", "<https://example.com/unsubscribe/token>", "List-Unsubscribe=One-Click");
  addThread("mailto", "Course Ads <ads@example.org>", "<mailto:unsubscribe@example.org?subject=Remove>");
  const posts: string[] = [];
  const sends: string[] = [];
  registerMailRoutes(app, auth, memory, {
    masterKey,
    unsubscribeFetch: (async (url, init) => { posts.push(String(url)); assert.equal(init?.body, "List-Unsubscribe=One-Click"); return new Response(null, { status: 503 }); }) as typeof fetch,
    gmailClientFactory: () => ({ sendMessage: async ({ raw }: { raw: string }) => { sends.push(raw); return { id: "unsubscribe-message", threadId: "unsubscribe-thread" }; } }) as any,
  });
  const headers = { authorization: "Bearer token" };
  const candidates = await app.inject({ method: "GET", url: `/api/mail/accounts/${accountId}/unsubscribe/candidates`, headers });
  assert.equal(candidates.statusCode, 200, candidates.body);
  assert.equal(candidates.json().items.length, 2);
  const proposed = await app.inject({ method: "POST", url: `/api/mail/accounts/${accountId}/unsubscribe/proposals`, headers, payload: { candidateIds: candidates.json().items.map((item: any) => item.id) } });
  assert.equal(proposed.statusCode, 200, proposed.body);
  const operationId = proposed.json().operationId;
  assert.equal((await app.inject({ method: "POST", url: `/api/mail/unsubscribe-operations/${operationId}/execute`, headers })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `/api/mail/unsubscribe-operations/${operationId}/approve`, headers })).statusCode, 200);
  const executed = await app.inject({ method: "POST", url: `/api/mail/unsubscribe-operations/${operationId}/execute`, headers });
  assert.equal(executed.statusCode, 200, executed.body);
  assert.equal(executed.json().ok, false);
  assert.equal(executed.json().results.filter((item: any) => item.ok).length, 1);
  assert.equal(executed.json().results.filter((item: any) => !item.ok).length, 1);
  assert.equal(posts.length, 1);
  assert.equal(sends.length, 1);
  const replay = await app.inject({ method: "POST", url: `/api/mail/unsubscribe-operations/${operationId}/execute`, headers });
  assert.equal(replay.json().replay, true);
  assert.equal(posts.length, 1);
  assert.equal(sends.length, 1);

  await app.close();
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
