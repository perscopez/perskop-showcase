import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MemoryStore } from "../db.js";
import { ConnectorSecretStore } from "../connectors/secretStore.js";
import { GmailApiError, GmailClient, type GmailMessagePart } from "../connectors/google/gmail.js";
import { createGmailOAuthRequest } from "../connectors/google/mailOAuth.js";
import {
  exchangeGoogleAuthorizationCode,
  GoogleOAuthStateStore,
  refreshGoogleAccessToken,
} from "../connectors/google/oauth.js";
import { GmailStore, type GmailDraftAttachment, type StoredGmailDraft } from "../email/gmailStore.js";
import type { SenderRule } from "../email/classification.js";
import { sendOAuthSuccess } from "./oauthResponse.js";
import { refreshGmailThread, syncGmailAccount } from "../email/gmailSync.js";
import {
  canonicalEmailSendApproval,
  emailApprovalMatches,
  hashEmailSendApproval,
  type EmailSendApproval,
} from "../security/emailApproval.js";
import {
  canonicalUnsubscribeApproval,
  extractUnsubscribeCandidate,
  hashUnsubscribeApproval,
  unsubscribeApprovalMatches,
  type UnsubscribeCandidate,
} from "../email/unsubscribe.js";
import { TaskService, type TaskTransitionFields } from "../tasks/taskService.js";
import type { TaskStatus } from "../tasks/stateMachine.js";

const GMAIL_OAUTH_CONFIG_ACCOUNT_ID = "google_mail_oauth_config";
const GMAIL_OAUTH_PROVIDER = "google_mail";
const CALENDAR_OAUTH_CONFIG_ACCOUNT_ID = "google_oauth_config";

type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function upsertConnectorAccount(
  memory: MemoryStore,
  input: { id: string; source: string; displayName: string; status: string },
) {
  memory.db.prepare(`
    INSERT INTO connector_accounts (id, owner_id, source, display_name, status)
    VALUES (?, 'owner', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source,
      display_name=excluded.display_name,
      status=excluded.status,
      updated_at=datetime('now')
  `).run(input.id, input.source, input.displayName, input.status);
}

export function registerMailRoutes(
  app: FastifyInstance,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  memory: MemoryStore,
  options: {
    masterKey?: string;
    googleOAuth?: GoogleOAuthConfig;
    exchangeGoogleAuthorizationCode?: typeof exchangeGoogleAuthorizationCode;
    refreshGoogleAccessToken?: typeof refreshGoogleAccessToken;
    gmailClientFactory?: (input: { accessToken: string }) => GmailClient;
    unsubscribeFetch?: typeof fetch;
  } = {},
) {
  const taskService = new TaskService(memory);
  const transitionTask = (taskId: number, to: TaskStatus, fields?: TaskTransitionFields) => {
    const row = memory.db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId) as { revision: number } | undefined;
    if (!row) throw new Error("task_not_found");
    return taskService.transition(taskId, { to, expectedRevision: row.revision, fields });
  };
  const getGoogleOAuthConfig = (): GoogleOAuthConfig | null => {
    if (options.googleOAuth) return options.googleOAuth;
    if (!options.masterKey) return null;
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    const clientId = secrets.get(GMAIL_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_id");
    const clientSecret = secrets.get(GMAIL_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_secret");
    const redirectUri = secrets.get(GMAIL_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_redirect_uri");
    if (clientId && clientSecret && redirectUri) return { clientId, clientSecret, redirectUri };
    const sharedClientId = secrets.get(CALENDAR_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_id");
    const sharedClientSecret = secrets.get(CALENDAR_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_client_secret");
    const sharedRedirectUri = secrets.get(CALENDAR_OAUTH_CONFIG_ACCOUNT_ID, "google_oauth_redirect_uri");
    if (!sharedClientId || !sharedClientSecret || !sharedRedirectUri) return null;
    return { clientId: sharedClientId, clientSecret: sharedClientSecret, redirectUri: sharedRedirectUri };
  };

  const getAccount = (accountId: string) => memory.db.prepare(`
    SELECT id,display_name,status FROM connector_accounts
    WHERE id=? AND owner_id='owner' AND source=?
  `).get(accountId, GMAIL_OAUTH_PROVIDER) as { id: string; display_name: string; status: string } | undefined;

  const getGmailClient = async (accountId: string): Promise<GmailClient> => {
    if (!options.masterKey) throw new Error("connector_encryption_not_configured");
    const account = getAccount(accountId);
    if (!account || account.status === "disabled") throw new Error("gmail_account_not_found");
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    let accessToken = secrets.get(accountId, "google_access_token");
    const expiresAt = Number(secrets.get(accountId, "google_access_expires_at") ?? 0);
    if (!accessToken || (expiresAt > 0 && expiresAt <= Date.now() + 30_000)) {
      const config = getGoogleOAuthConfig();
      const refreshToken = secrets.get(accountId, "google_refresh_token");
      if (!config || !refreshToken) throw new Error("gmail_connector_needs_reauth");
      const refreshed = await (options.refreshGoogleAccessToken ?? refreshGoogleAccessToken)({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken,
      });
      accessToken = refreshed.access_token;
      secrets.put({ accountId, kind: "google_access_token", value: accessToken });
      if (refreshed.expires_in) {
        secrets.put({
          accountId,
          kind: "google_access_expires_at",
          value: String(Date.now() + refreshed.expires_in * 1000),
        });
      }
    }
    return options.gmailClientFactory?.({ accessToken }) ?? new GmailClient({ accessToken });
  };

  const sendMailError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    const code = error instanceof Error ? error.message : "gmail_request_failed";
    if (code === "gmail_account_not_found") return reply.code(404).send({ error: code });
    if (code === "gmail_connector_needs_reauth") return reply.code(409).send({ error: code });
    if (code === "connector_encryption_not_configured") return reply.code(503).send({ error: code });
    if (error instanceof GmailApiError) {
      request.log.warn({ status: error.status, reason: error.reason }, "Gmail API request failed");
      if (
        error.status === 403
        && ["accessNotConfigured", "SERVICE_DISABLED"].includes(error.reason ?? "")
      ) {
        return reply.code(503).send({ error: "gmail_api_not_enabled" });
      }
      if (error.status === 401 || error.status === 403) return reply.code(409).send({ error: "gmail_connector_needs_reauth" });
      if (error.status === 404) return reply.code(404).send({ error: "gmail_resource_not_found" });
    }
    request.log.warn({ err: error }, "Gmail request failed");
    return reply.code(502).send({ error: "gmail_request_failed" });
  };

  const attachmentMetadata = (part: GmailMessagePart | undefined): Array<{
    partId: string | null;
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
  }> => {
    if (!part) return [];
    const own = part.body?.attachmentId ? [{
      partId: part.partId ?? null,
      attachmentId: part.body.attachmentId,
      filename: part.filename ?? "attachment",
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    }] : [];
    return own.concat((part.parts ?? []).flatMap(attachmentMetadata));
  };

  const draftInputSchema = z.object({
    threadId: z.string().min(1).max(200).nullable().default(null),
    to: z.array(z.string().email().max(320)).max(100).default([]),
    cc: z.array(z.string().email().max(320)).max(100).default([]),
    bcc: z.array(z.string().email().max(320)).max(100).default([]),
    subject: z.string().max(998).default(""),
    bodyText: z.string().max(2_000_000).default(""),
    attachments: z.array(z.object({
      id: z.string().min(1).max(200).optional(),
      filename: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(200),
      dataBase64: z.string().max(35_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    }).strict()).max(50).default([]),
  }).strict().superRefine((value, context) => {
    const bytes = value.attachments.reduce((sum, attachment) => sum + Buffer.byteLength(attachment.dataBase64, "base64"), 0);
    if (bytes > 25 * 1024 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, path: ["attachments"], message: "attachments exceed 25 MB" });
  });

  const normalizeDraftAttachments = (attachments: z.infer<typeof draftInputSchema>["attachments"]): GmailDraftAttachment[] => attachments.map((attachment) => {
    const data = Buffer.from(attachment.dataBase64, "base64");
    return {
      id: attachment.id ?? `attachment-${crypto.randomBytes(12).toString("hex")}`,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      dataBase64: data.toString("base64"),
    };
  });

  const publicDraft = (draft: StoredGmailDraft) => ({
    ...draft,
    attachments: draft.attachments.map(({ dataBase64: _dataBase64, ...attachment }) => attachment),
  });

  const approvalPayloadForDraft = (draft: StoredGmailDraft, taskId: number, nonce: string): EmailSendApproval => ({
    schemaVersion: 1,
    operationType: "email_send",
    taskId,
    accountId: draft.accountId,
    draftId: draft.draftId,
    threadId: draft.threadId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyText: draft.bodyText,
    attachments: draft.attachments.map(({ dataBase64: _dataBase64, ...attachment }) => attachment),
    nonce,
  });

  const encodeHeader = (value: string) => `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
  const wrapBase64 = (value: string) => value.match(/.{1,76}/g)?.join("\r\n") ?? "";
  const buildRawMessage = (draft: StoredGmailDraft): string => {
    const headers = [
      `To: ${draft.to.join(", ")}`,
      ...(draft.cc.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
      ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(", ")}`] : []),
      `Subject: ${encodeHeader(draft.subject)}`,
      "MIME-Version: 1.0",
    ];
    if (!draft.attachments.length) {
      return Buffer.from([
        ...headers,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(Buffer.from(draft.bodyText, "utf8").toString("base64")),
      ].join("\r\n"), "utf8").toString("base64url");
    }
    const boundary = `perskop-${crypto.randomBytes(18).toString("hex")}`;
    const body = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(draft.bodyText, "utf8").toString("base64")),
    ];
    for (const attachment of draft.attachments) {
      body.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${encodeHeader(attachment.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename)}"`,
        `X-Attachment-Id: ${attachment.id}`,
        "",
        wrapBase64(attachment.dataBase64),
      );
    }
    body.push(`--${boundary}--`, "");
    return Buffer.from(body.join("\r\n"), "utf8").toString("base64url");
  };

  const invalidateDraftApprovals = (accountId: string, draftId: string) => {
    const rows = memory.db.prepare(`
      SELECT o.operation_id,o.approval_id,a.status AS approval_status
      FROM gmail_send_operations o JOIN approvals a ON a.id=o.approval_id
      WHERE o.account_id=? AND o.draft_id=? AND o.status IN ('pending','approved')
    `).all(accountId, draftId) as Array<{ operation_id: string; approval_id: string; approval_status: string }>;
    const transaction = memory.db.transaction(() => {
      for (const row of rows) {
        if (["pending", "approved", "claimed"].includes(row.approval_status)) memory.setApprovalStatus(row.approval_id, "consumed");
        memory.db.prepare("UPDATE gmail_send_operations SET status='invalidated',completed_at=datetime('now') WHERE operation_id=?").run(row.operation_id);
      }
    });
    transaction();
  };

  const listUnsubscribeCandidates = (accountId: string): UnsubscribeCandidate[] => {
    const store = new GmailStore(memory.db);
    const grouped = new Map<string, UnsubscribeCandidate>();
    for (const summary of store.listThreads({ accountId, includeHidden: true, limit: 500 })) {
      const thread = store.getThread(accountId, summary.threadId);
      const candidate = thread ? extractUnsubscribeCandidate(thread) : null;
      if (!candidate) continue;
      const key = candidate.sender.toLowerCase();
      if (!grouped.has(key)) grouped.set(key, candidate);
    }
    return [...grouped.values()].sort((a, b) => a.sender.localeCompare(b.sender));
  };

  app.get("/api/mail/connectors/google/oauth/status", { preHandler: auth }, async () => {
    const accounts = memory.db.prepare(`
      SELECT id, display_name, status, created_at, updated_at
      FROM connector_accounts
      WHERE owner_id='owner' AND source=?
      ORDER BY updated_at DESC
    `).all(GMAIL_OAUTH_PROVIDER).map((row: any) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return { configured: Boolean(getGoogleOAuthConfig()), accounts };
  });

  app.post("/api/mail/connectors/google/oauth/config", { preHandler: auth }, async (request, reply) => {
    if (!options.masterKey) {
      return reply.code(503).send({ error: "connector encryption is not configured" });
    }
    const parsed = z.object({
      clientId: z.string().min(20),
      clientSecret: z.string().min(8),
      redirectUri: z.string().url(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "gmail_oauth_config_required" });

    upsertConnectorAccount(memory, {
      id: GMAIL_OAUTH_CONFIG_ACCOUNT_ID,
      source: "google_mail_config",
      displayName: "Google Mail OAuth",
      status: "connected",
    });
    const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
    secrets.put({ accountId: GMAIL_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_client_id", value: parsed.data.clientId });
    secrets.put({ accountId: GMAIL_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_client_secret", value: parsed.data.clientSecret });
    secrets.put({ accountId: GMAIL_OAUTH_CONFIG_ACCOUNT_ID, kind: "google_oauth_redirect_uri", value: parsed.data.redirectUri });
    return { ok: true, configured: true };
  });

  app.post("/api/mail/connectors/google/oauth/start", { preHandler: auth }, async (request, reply) => {
    const googleOAuth = getGoogleOAuthConfig();
    if (!options.masterKey || !googleOAuth) {
      return reply.code(503).send({ error: "Gmail connection is not configured" });
    }
    const body = z.object({ displayName: z.string().min(1).max(100).default("Gmail") }).parse(request.body ?? {});
    const accountId = `google_mail_${crypto.createHash("sha256").update("owner:google_mail").digest("hex").slice(0, 24)}`;
    const oauth = createGmailOAuthRequest({ clientId: googleOAuth.clientId, redirectUri: googleOAuth.redirectUri });
    upsertConnectorAccount(memory, {
      id: accountId,
      source: GMAIL_OAUTH_PROVIDER,
      displayName: body.displayName,
      status: "needs_reauth",
    });
    new GoogleOAuthStateStore(memory.db, options.masterKey, GMAIL_OAUTH_PROVIDER).save({
      state: oauth.state,
      accountId,
      verifier: oauth.codeVerifier,
    });
    return { ok: true, accountId, authorizationUrl: oauth.url };
  });

  app.get("/api/mail/connectors/google/oauth/callback", async (request, reply) => {
    const googleOAuth = getGoogleOAuthConfig();
    if (!options.masterKey || !googleOAuth) {
      return reply.code(503).send({ error: "Gmail connection is not configured" });
    }
    const query = z.object({
      state: z.string().min(20),
      code: z.string().min(1).optional(),
      error: z.string().optional(),
    }).parse(request.query);
    if (query.error) return reply.code(400).send({ error: "Gmail authorization was not granted" });
    if (!query.code) return reply.code(400).send({ error: "Gmail authorization code is missing" });
    const pending = new GoogleOAuthStateStore(memory.db, options.masterKey, GMAIL_OAUTH_PROVIDER).consume(query.state);
    if (!pending) return reply.code(400).send({ error: "Gmail authorization is invalid or expired" });

    try {
      const token = await (options.exchangeGoogleAuthorizationCode ?? exchangeGoogleAuthorizationCode)({
        ...googleOAuth,
        code: query.code,
        codeVerifier: pending.verifier,
      });
      const secrets = new ConnectorSecretStore(memory.db, options.masterKey);
      secrets.put({ accountId: pending.accountId, kind: "google_access_token", value: token.access_token });
      if (token.refresh_token) {
        secrets.put({ accountId: pending.accountId, kind: "google_refresh_token", value: token.refresh_token });
      }
      if (token.expires_in) {
        secrets.put({
          accountId: pending.accountId,
          kind: "google_access_expires_at",
          value: String(Date.now() + token.expires_in * 1000),
        });
      }
      memory.db.prepare("UPDATE connector_accounts SET status='connected', updated_at=datetime('now') WHERE id=? AND source=?").run(pending.accountId, GMAIL_OAUTH_PROVIDER);
      return sendOAuthSuccess(request, reply, { connector: "Gmail", payload: { ok: true, accountId: pending.accountId, status: "connected" } });
    } catch (error) {
      memory.db.prepare("UPDATE connector_accounts SET status='error', updated_at=datetime('now') WHERE id=? AND source=?").run(pending.accountId, GMAIL_OAUTH_PROVIDER);
      request.log.warn({ err: error, accountId: pending.accountId }, "Gmail OAuth completion failed");
      return reply.code(502).send({ error: "Gmail connection could not be completed" });
    }
  });

  app.post("/api/mail/accounts/:id/disconnect", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const account = memory.db.prepare("SELECT id FROM connector_accounts WHERE id=? AND owner_id='owner' AND source=?").get(id, GMAIL_OAUTH_PROVIDER);
    if (!account) return reply.code(404).send({ error: "gmail_account_not_found" });
    if (options.masterKey) new ConnectorSecretStore(memory.db, options.masterKey).deleteAccount(id);
    memory.db.prepare("UPDATE connector_accounts SET status='disabled', updated_at=datetime('now') WHERE id=?").run(id);
    return { ok: true, accountId: id, status: "disabled" };
  });

  app.get("/api/mail/accounts/:id/sync/status", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const state = new GmailStore(memory.db).getAccount(id);
    return { accountId: id, connected: true, synced: Boolean(state), ...state };
  });

  app.post("/api/mail/accounts/:id/sync", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const body = z.object({ maxThreads: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.body ?? {});
    try {
      const sync = await syncGmailAccount({ memory, client: await getGmailClient(id), accountId: id, maxThreads: body.maxThreads });
      return { ok: true, accountId: id, sync };
    } catch (error) {
      return sendMailError(request, reply, error);
    }
  });

  app.get("/api/mail/accounts/:id/labels", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    return { accountId: id, items: new GmailStore(memory.db).listLabels(id) };
  });

  app.get("/api/mail/sender-rules", { preHandler: auth }, async () => ({
    items: new GmailStore(memory.db).listSenderRules(),
  }));

  app.put("/api/mail/sender-rules", { preHandler: auth }, async (request) => {
    const rule = z.object({
      pattern: z.string().trim().min(3).max(320),
      action: z.enum(["important", "promotion", "normal"]),
    }).parse(request.body) as SenderRule;
    const store = new GmailStore(memory.db);
    return { ok: true, item: store.upsertSenderRule(rule) };
  });

  app.delete("/api/mail/sender-rules", { preHandler: auth }, async (request, reply) => {
    const { pattern } = z.object({ pattern: z.string().trim().min(3).max(320) }).parse(request.body);
    const changes = new GmailStore(memory.db).deleteSenderRule(pattern);
    if (!changes) return reply.code(404).send({ error: "mail_sender_rule_not_found" });
    return { ok: true, pattern };
  });

  app.get("/api/mail/accounts/:id/threads", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const query = z.object({
      includeHidden: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
      category: z.enum(["urgent", "priority", "normal", "promotion"]).optional(),
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    return { accountId: id, items: new GmailStore(memory.db).listThreads({ accountId: id, ...query }) };
  });

  app.get("/api/mail/accounts/:id/threads/:threadId", { preHandler: auth }, async (request, reply) => {
    const { id, threadId } = z.object({ id: z.string().min(1).max(200), threadId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const item = new GmailStore(memory.db).getThread(id, threadId);
    if (!item) return reply.code(404).send({ error: "gmail_thread_not_found" });
    return { accountId: id, item };
  });

  app.get("/api/mail/accounts/:id/threads/:threadId/attachments", { preHandler: auth }, async (request, reply) => {
    const { id, threadId } = z.object({ id: z.string().min(1).max(200), threadId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const thread = new GmailStore(memory.db).getThread(id, threadId);
    if (!thread) return reply.code(404).send({ error: "gmail_thread_not_found" });
    return {
      accountId: id,
      threadId,
      items: thread.messages.flatMap((message) => attachmentMetadata(message.payload as GmailMessagePart).map((item) => ({ ...item, messageId: message.messageId }))),
    };
  });

  app.get("/api/mail/accounts/:id/messages/:messageId/attachments/:attachmentId", { preHandler: auth }, async (request, reply) => {
    const { id, messageId, attachmentId } = z.object({
      id: z.string().min(1).max(200),
      messageId: z.string().min(1).max(200),
      attachmentId: z.string().min(1).max(500),
    }).parse(request.params);
    try {
      const attachment = await (await getGmailClient(id)).getAttachment(messageId, attachmentId);
      return { accountId: id, messageId, attachmentId, size: attachment.size, data: attachment.data.toString("base64") };
    } catch (error) {
      return sendMailError(request, reply, error);
    }
  });

  app.post("/api/mail/accounts/:id/threads/:threadId/mutate", { preHandler: auth }, async (request, reply) => {
    const { id, threadId } = z.object({ id: z.string().min(1).max(200), threadId: z.string().min(1).max(200) }).parse(request.params);
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.enum(["read", "unread", "star", "unstar", "archive", "spam"]) }),
      z.object({ action: z.literal("trash") }),
      z.object({ action: z.literal("restore") }),
      z.object({ action: z.literal("labels"), addLabelIds: z.array(z.string().min(1)).max(50).default([]), removeLabelIds: z.array(z.string().min(1)).max(50).default([]) }),
    ]).parse(request.body);
    try {
      const client = await getGmailClient(id);
      if (body.action === "trash") await client.trashThread(threadId);
      else if (body.action === "restore") await client.untrashThread(threadId);
      else {
        const labels = body.action === "labels" ? { addLabelIds: body.addLabelIds, removeLabelIds: body.removeLabelIds }
          : body.action === "read" ? { removeLabelIds: ["UNREAD"] }
          : body.action === "unread" ? { addLabelIds: ["UNREAD"] }
          : body.action === "star" ? { addLabelIds: ["STARRED"] }
          : body.action === "unstar" ? { removeLabelIds: ["STARRED"] }
          : body.action === "archive" ? { removeLabelIds: ["INBOX"] }
          : { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] };
        await client.modifyThread(threadId, labels);
      }
      const item = await refreshGmailThread({ memory, client, accountId: id, threadId });
      return { ok: true, accountId: id, threadId, action: body.action, item };
    } catch (error) {
      return sendMailError(request, reply, error);
    }
  });

  app.get("/api/mail/accounts/:id/drafts", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    return { accountId: id, items: new GmailStore(memory.db).listDrafts(id).map(publicDraft) };
  });

  app.post("/api/mail/accounts/:id/drafts", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const body = draftInputSchema.parse(request.body ?? {});
    const draft = new GmailStore(memory.db).createDraft({
      draftId: `gmail-draft-${crypto.randomBytes(12).toString("hex")}`,
      accountId: id,
      threadId: body.threadId,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      bodyText: body.bodyText,
      attachments: normalizeDraftAttachments(body.attachments),
    });
    return reply.code(201).send({ ok: true, item: publicDraft(draft) });
  });

  app.get("/api/mail/accounts/:id/drafts/:draftId", { preHandler: auth }, async (request, reply) => {
    const { id, draftId } = z.object({ id: z.string().min(1).max(200), draftId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const draft = new GmailStore(memory.db).getDraft(id, draftId);
    if (!draft) return reply.code(404).send({ error: "gmail_draft_not_found" });
    return { item: publicDraft(draft) };
  });

  app.patch("/api/mail/accounts/:id/drafts/:draftId", { preHandler: auth }, async (request, reply) => {
    const { id, draftId } = z.object({ id: z.string().min(1).max(200), draftId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const body = draftInputSchema.parse(request.body ?? {});
    invalidateDraftApprovals(id, draftId);
    const draft = new GmailStore(memory.db).updateDraft({
      draftId,
      accountId: id,
      threadId: body.threadId,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      bodyText: body.bodyText,
      attachments: normalizeDraftAttachments(body.attachments),
    });
    if (!draft) return reply.code(404).send({ error: "gmail_draft_not_found_or_sent" });
    return { ok: true, approvalInvalidated: true, item: publicDraft(draft) };
  });

  app.delete("/api/mail/accounts/:id/drafts/:draftId", { preHandler: auth }, async (request, reply) => {
    const { id, draftId } = z.object({ id: z.string().min(1).max(200), draftId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    invalidateDraftApprovals(id, draftId);
    if (!new GmailStore(memory.db).deleteDraft(id, draftId)) return reply.code(404).send({ error: "gmail_draft_not_found_or_sent" });
    return { ok: true, draftId };
  });

  app.post("/api/mail/accounts/:id/drafts/:draftId/propose-send", { preHandler: auth }, async (request, reply) => {
    const { id, draftId } = z.object({ id: z.string().min(1).max(200), draftId: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const store = new GmailStore(memory.db);
    const draft = store.getDraft(id, draftId);
    if (!draft) return reply.code(404).send({ error: "gmail_draft_not_found" });
    if (draft.status === "sent") return reply.code(409).send({ error: "gmail_draft_already_sent" });
    if (!draft.to.length) return reply.code(400).send({ error: "gmail_draft_recipient_required" });
    invalidateDraftApprovals(id, draftId);
    const taskId = memory.addTask({
      source: "mac",
      prompt: `Send Gmail draft: ${draft.subject || "(no subject)"}`,
      workload: "email_send",
      proposed_operation: JSON.stringify(publicDraft(draft)),
      status: "waiting_approval",
    });
    const nonce = crypto.randomBytes(24).toString("base64url");
    const canonicalPayload = canonicalEmailSendApproval(approvalPayloadForDraft(draft, taskId, nonce));
    const payloadHash = hashEmailSendApproval(canonicalPayload);
    const approvalId = `email-${crypto.randomBytes(12).toString("hex")}`;
    const operationId = `email-op-${crypto.randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const transaction = memory.db.transaction(() => {
      memory.createApproval({
        id: approvalId,
        taskId,
        requestedBy: "owner",
        channelId: "mail",
        sessionId: "mail",
        operationType: "email_send",
        canonicalPayload,
        payloadHash,
        expiresAt,
        nonce,
      });
      memory.db.prepare("UPDATE tasks SET approval_id=? WHERE id=?").run(approvalId, taskId);
      memory.db.prepare(`
        INSERT INTO gmail_send_operations (operation_id,account_id,draft_id,approval_id,payload_hash,status)
        VALUES (?,?,?,?,?,'pending')
      `).run(operationId, id, draftId, approvalId, payloadHash);
      store.setDraftStatus(id, draftId, "waiting_approval");
    });
    transaction();
    return {
      ok: true,
      operationId,
      approvalId,
      status: "pending",
      expiresAt,
      preview: publicDraft(draft),
    };
  });

  const getSendOperation = (operationId: string) => memory.db.prepare(`
    SELECT o.*,a.task_id,a.status AS approval_status,a.expires_at,a.nonce,a.payload_hash AS approval_payload_hash
    FROM gmail_send_operations o JOIN approvals a ON a.id=o.approval_id
    WHERE o.operation_id=?
  `).get(operationId) as {
    operation_id: string;
    account_id: string;
    draft_id: string;
    approval_id: string;
    payload_hash: string;
    status: string;
    provider_message_id: string | null;
    task_id: number;
    approval_status: string;
    expires_at: string;
    nonce: string;
    approval_payload_hash: string;
  } | undefined;

  const validateCurrentDraftApproval = (operation: NonNullable<ReturnType<typeof getSendOperation>>) => {
    const draft = new GmailStore(memory.db).getDraft(operation.account_id, operation.draft_id);
    if (!draft) return { draft: null, matches: false };
    const currentHash = hashEmailSendApproval(canonicalEmailSendApproval(approvalPayloadForDraft(draft, operation.task_id, operation.nonce)));
    return { draft, matches: emailApprovalMatches(currentHash, operation.payload_hash) && emailApprovalMatches(currentHash, operation.approval_payload_hash) };
  };

  app.get("/api/mail/send-operations/:operationId", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getSendOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "email_send_operation_not_found" });
    return { item: { operationId, accountId: operation.account_id, draftId: operation.draft_id, status: operation.status, approvalStatus: operation.approval_status, expiresAt: operation.expires_at, providerMessageId: operation.provider_message_id } };
  });

  app.post("/api/mail/send-operations/:operationId/approve", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getSendOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "email_send_operation_not_found" });
    if (operation.status !== "pending" || operation.approval_status !== "pending") return reply.code(409).send({ error: "email_send_operation_not_pending" });
    if (new Date(operation.expires_at).getTime() <= Date.now()) {
      memory.setApprovalStatus(operation.approval_id, "expired");
      memory.db.prepare("UPDATE gmail_send_operations SET status='expired',completed_at=datetime('now') WHERE operation_id=?").run(operationId);
      return reply.code(409).send({ error: "email_send_approval_expired" });
    }
    const current = validateCurrentDraftApproval(operation);
    if (!current.matches || !current.draft) {
      invalidateDraftApprovals(operation.account_id, operation.draft_id);
      return reply.code(409).send({ error: "email_send_approval_invalidated" });
    }
    memory.setApprovalStatus(operation.approval_id, "approved", "owner");
    memory.db.prepare("UPDATE gmail_send_operations SET status='approved' WHERE operation_id=?").run(operationId);
    new GmailStore(memory.db).setDraftStatus(operation.account_id, operation.draft_id, "approved");
    return { ok: true, operationId, status: "approved" };
  });

  app.post("/api/mail/send-operations/:operationId/reject", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getSendOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "email_send_operation_not_found" });
    if (["sent", "rejected", "invalidated"].includes(operation.status)) return { ok: true, operationId, status: operation.status };
    memory.setApprovalStatus(operation.approval_id, "consumed");
    memory.db.prepare("UPDATE gmail_send_operations SET status='rejected',completed_at=datetime('now') WHERE operation_id=?").run(operationId);
    new GmailStore(memory.db).setDraftStatus(operation.account_id, operation.draft_id, "draft");
    transitionTask(operation.task_id, "rejected", { error: "Email send rejected by user" });
    return { ok: true, operationId, status: "rejected" };
  });

  app.post("/api/mail/send-operations/:operationId/execute", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getSendOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "email_send_operation_not_found" });
    if (operation.status === "sent") return { ok: true, operationId, status: "sent", providerMessageId: operation.provider_message_id, replay: true };
    if (operation.status !== "approved" || operation.approval_status !== "approved") return reply.code(409).send({ error: "email_send_requires_exact_approval" });
    if (new Date(operation.expires_at).getTime() <= Date.now()) {
      memory.setApprovalStatus(operation.approval_id, "expired");
      memory.db.prepare("UPDATE gmail_send_operations SET status='expired',completed_at=datetime('now') WHERE operation_id=?").run(operationId);
      return reply.code(409).send({ error: "email_send_approval_expired" });
    }
    const current = validateCurrentDraftApproval(operation);
    if (!current.matches || !current.draft) {
      invalidateDraftApprovals(operation.account_id, operation.draft_id);
      return reply.code(409).send({ error: "email_send_approval_invalidated" });
    }
    if (!memory.claimApproval(operation.approval_id)) return reply.code(409).send({ error: "email_send_approval_already_claimed" });
    transitionTask(operation.task_id, "running");
    try {
      const result = await (await getGmailClient(operation.account_id)).sendMessage({
        raw: buildRawMessage(current.draft),
        threadId: current.draft.threadId,
      });
      const transaction = memory.db.transaction(() => {
        memory.setApprovalStatus(operation.approval_id, "consumed");
        memory.db.prepare("UPDATE gmail_send_operations SET status='sent',provider_message_id=?,completed_at=datetime('now') WHERE operation_id=?").run(result.id, operationId);
        new GmailStore(memory.db).setDraftStatus(operation.account_id, operation.draft_id, "sent");
      });
      transaction();
      transitionTask(operation.task_id, "succeeded", { response: `Gmail message sent: ${result.id}`, provider: "gmail" });
      return { ok: true, operationId, status: "sent", providerMessageId: result.id };
    } catch (error) {
      memory.setApprovalStatus(operation.approval_id, "consumed");
      memory.db.prepare("UPDATE gmail_send_operations SET status='failed',completed_at=datetime('now') WHERE operation_id=?").run(operationId);
      transitionTask(operation.task_id, "failed", { error: "Gmail send failed after approval claim" });
      return sendMailError(request, reply, error);
    }
  });

  app.get("/api/mail/accounts/:id/unsubscribe/candidates", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    return { accountId: id, items: listUnsubscribeCandidates(id) };
  });

  app.post("/api/mail/accounts/:id/unsubscribe/proposals", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!getAccount(id)) return reply.code(404).send({ error: "gmail_account_not_found" });
    const body = z.object({ candidateIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).parse(request.body);
    const available = new Map(listUnsubscribeCandidates(id).map(candidate => [candidate.id, candidate]));
    const selected = [...new Set(body.candidateIds)].map(candidateId => available.get(candidateId)).filter((candidate): candidate is UnsubscribeCandidate => Boolean(candidate));
    if (selected.length !== new Set(body.candidateIds).size) return reply.code(409).send({ error: "unsubscribe_candidate_changed" });
    const taskId = memory.addTask({ source: "mac", prompt: `Unsubscribe from ${selected.length} sender(s)`, workload: "email_unsubscribe", proposed_operation: JSON.stringify(selected), status: "waiting_approval" });
    const nonce = crypto.randomBytes(24).toString("base64url");
    const canonicalPayload = canonicalUnsubscribeApproval({
      schemaVersion: 1,
      operationType: "email_unsubscribe",
      taskId,
      accountId: id,
      candidates: selected.map(candidate => ({ id: candidate.id, sender: candidate.sender, oneClickUrl: candidate.oneClickUrl, mailtoUrl: candidate.mailtoUrl })),
      nonce,
    });
    const payloadHash = hashUnsubscribeApproval(canonicalPayload);
    const approvalId = `unsubscribe-${crypto.randomBytes(12).toString("hex")}`;
    const operationId = `unsubscribe-op-${crypto.randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const transaction = memory.db.transaction(() => {
      memory.createApproval({ id: approvalId, taskId, requestedBy: "owner", channelId: "mail", sessionId: "mail", operationType: "email_unsubscribe", canonicalPayload, payloadHash, expiresAt, nonce });
      memory.db.prepare("UPDATE tasks SET approval_id=? WHERE id=?").run(approvalId, taskId);
      memory.db.prepare(`INSERT INTO gmail_unsubscribe_operations (operation_id,account_id,approval_id,payload_hash,candidates_json) VALUES (?,?,?,?,?)`).run(operationId, id, approvalId, payloadHash, JSON.stringify(selected));
    });
    transaction();
    return { ok: true, operationId, approvalId, status: "pending", expiresAt, preview: selected };
  });

  const getUnsubscribeOperation = (operationId: string) => memory.db.prepare(`
    SELECT o.*,a.task_id,a.status AS approval_status,a.expires_at,a.nonce,a.payload_hash AS approval_payload_hash
    FROM gmail_unsubscribe_operations o JOIN approvals a ON a.id=o.approval_id WHERE o.operation_id=?
  `).get(operationId) as any;

  const currentUnsubscribeHash = (operation: any, candidates: UnsubscribeCandidate[]) => hashUnsubscribeApproval(canonicalUnsubscribeApproval({
    schemaVersion: 1,
    operationType: "email_unsubscribe",
    taskId: operation.task_id,
    accountId: operation.account_id,
    candidates: candidates.map(candidate => ({ id: candidate.id, sender: candidate.sender, oneClickUrl: candidate.oneClickUrl, mailtoUrl: candidate.mailtoUrl })),
    nonce: operation.nonce,
  }));

  app.post("/api/mail/unsubscribe-operations/:operationId/approve", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getUnsubscribeOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "unsubscribe_operation_not_found" });
    if (operation.status !== "pending" || operation.approval_status !== "pending") return reply.code(409).send({ error: "unsubscribe_operation_not_pending" });
    if (new Date(operation.expires_at).getTime() <= Date.now()) return reply.code(409).send({ error: "unsubscribe_approval_expired" });
    const candidates = JSON.parse(operation.candidates_json) as UnsubscribeCandidate[];
    const available = new Map(listUnsubscribeCandidates(operation.account_id).map(candidate => [candidate.id, candidate]));
    const currentCandidates = candidates.map(candidate => available.get(candidate.id)).filter((candidate): candidate is UnsubscribeCandidate => Boolean(candidate));
    if (currentCandidates.length !== candidates.length) return reply.code(409).send({ error: "unsubscribe_candidate_changed" });
    const current = currentUnsubscribeHash(operation, currentCandidates);
    if (!unsubscribeApprovalMatches(current, operation.payload_hash) || !unsubscribeApprovalMatches(current, operation.approval_payload_hash)) return reply.code(409).send({ error: "unsubscribe_approval_invalidated" });
    memory.setApprovalStatus(operation.approval_id, "approved", "owner");
    memory.db.prepare("UPDATE gmail_unsubscribe_operations SET status='approved' WHERE operation_id=?").run(operationId);
    return { ok: true, operationId, status: "approved" };
  });

  app.post("/api/mail/unsubscribe-operations/:operationId/execute", { preHandler: auth }, async (request, reply) => {
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).parse(request.params);
    const operation = getUnsubscribeOperation(operationId);
    if (!operation) return reply.code(404).send({ error: "unsubscribe_operation_not_found" });
    if (operation.status === "completed") return { ok: true, operationId, status: "completed", results: JSON.parse(operation.results_json ?? "[]"), replay: true };
    if (operation.status !== "approved" || operation.approval_status !== "approved") return reply.code(409).send({ error: "unsubscribe_requires_exact_approval" });
    if (new Date(operation.expires_at).getTime() <= Date.now()) return reply.code(409).send({ error: "unsubscribe_approval_expired" });
    const candidates = JSON.parse(operation.candidates_json) as UnsubscribeCandidate[];
    const available = new Map(listUnsubscribeCandidates(operation.account_id).map(candidate => [candidate.id, candidate]));
    const currentCandidates = candidates.map(candidate => available.get(candidate.id)).filter((candidate): candidate is UnsubscribeCandidate => Boolean(candidate));
    if (currentCandidates.length !== candidates.length) return reply.code(409).send({ error: "unsubscribe_candidate_changed" });
    const current = currentUnsubscribeHash(operation, currentCandidates);
    if (!unsubscribeApprovalMatches(current, operation.payload_hash) || !unsubscribeApprovalMatches(current, operation.approval_payload_hash)) return reply.code(409).send({ error: "unsubscribe_approval_invalidated" });
    if (!memory.claimApproval(operation.approval_id)) return reply.code(409).send({ error: "unsubscribe_approval_already_claimed" });
    transitionTask(operation.task_id, "running");
    const results: Array<{ candidateId: string; sender: string; ok: boolean; method: string; error?: string }> = [];
    let client: GmailClient | null = null;
    for (const candidate of candidates) {
      try {
        if (candidate.oneClickUrl) {
          const response = await (options.unsubscribeFetch ?? fetch)(candidate.oneClickUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "error" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          results.push({ candidateId: candidate.id, sender: candidate.sender, ok: true, method: "one_click" });
        } else if (candidate.mailtoUrl) {
          const target = new URL(candidate.mailtoUrl);
          const address = decodeURIComponent(target.pathname);
          const subject = target.searchParams.get("subject") ?? "Unsubscribe";
          const bodyText = target.searchParams.get("body") ?? "Unsubscribe";
          client ??= await getGmailClient(operation.account_id);
          const raw = buildRawMessage({ draftId: "unsubscribe", accountId: operation.account_id, threadId: null, to: [address], cc: [], bcc: [], subject, bodyText, attachments: [], revision: 1, status: "approved", createdAt: "", updatedAt: "" });
          await client.sendMessage({ raw });
          results.push({ candidateId: candidate.id, sender: candidate.sender, ok: true, method: "mailto" });
        } else throw new Error("No safe executable method");
      } catch (error) {
        results.push({ candidateId: candidate.id, sender: candidate.sender, ok: false, method: candidate.oneClickUrl ? "one_click" : "mailto", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const transaction = memory.db.transaction(() => {
      memory.setApprovalStatus(operation.approval_id, "consumed");
      memory.db.prepare("UPDATE gmail_unsubscribe_operations SET status='completed',results_json=?,completed_at=datetime('now') WHERE operation_id=?").run(JSON.stringify(results), operationId);
    });
    transaction();
    transitionTask(operation.task_id, "succeeded", { response: `Unsubscribe completed: ${results.filter(result => result.ok).length}/${results.length}`, provider: "deterministic_tool" });
    return { ok: results.every(result => result.ok), operationId, status: "completed", results };
  });
}
