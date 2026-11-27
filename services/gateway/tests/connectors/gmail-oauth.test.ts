import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGmailOAuthRequest, GMAIL_OAUTH_SCOPES } from "../../src/connectors/google/mailOAuth.js";
import { GoogleOAuthStateStore } from "../../src/connectors/google/oauth.js";
import { MemoryStore } from "../../src/db.js";

test("Gmail OAuth request uses PKCE and least-privilege Gmail scopes", () => {
  const result = createGmailOAuthRequest({
    clientId: "client",
    redirectUri: "https://perskop.example/api/mail/connectors/google/oauth/callback",
  });
  const url = new URL(result.url);
  const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));

  assert.equal(url.searchParams.get("state"), result.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.deepEqual(scopes, new Set(GMAIL_OAUTH_SCOPES));
  assert.equal(scopes.has("https://mail.google.com/"), false);
  assert.equal(scopes.has("https://www.googleapis.com/auth/calendar"), false);
  assert.ok(result.codeVerifier.length > 40);
});

test("Calendar and Gmail OAuth states cannot consume each other", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-gmail-oauth-"));
  const memory = new MemoryStore(dir);
  memory.db.prepare("INSERT INTO connector_accounts (id,owner_id,source,display_name,status) VALUES ('mail-a','owner','google_mail','Gmail','needs_reauth')").run();
  const key = crypto.randomBytes(32).toString("base64");
  const gmail = new GoogleOAuthStateStore(memory.db, key, "google_mail");
  const calendar = new GoogleOAuthStateStore(memory.db, key, "google");
  gmail.save({ state: "mail-state", accountId: "mail-a", verifier: "mail-verifier" });

  assert.equal(calendar.consume("mail-state"), null);
  assert.deepEqual(gmail.consume("mail-state"), { accountId: "mail-a", verifier: "mail-verifier" });
  assert.equal(gmail.consume("mail-state"), null);

  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
