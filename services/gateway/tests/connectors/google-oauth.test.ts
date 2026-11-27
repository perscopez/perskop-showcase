import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleOAuthRequest, exchangeGoogleAuthorizationCode } from "../../src/connectors/google/oauth.js";
import { GoogleOAuthStateStore } from "../../src/connectors/google/oauth.js";
import { MemoryStore } from "../../src/db.js";
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";

test("Google OAuth request uses state, PKCE and Calendar-only scope", () => {
  const result = createGoogleOAuthRequest({ clientId: "client", redirectUri: "https://perskop.example/callback" });
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("state"), result.state); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar"); assert.ok(result.codeVerifier.length > 40);
});

test("Google OAuth token exchange sends PKCE verifier without leaking it in URL", async () => {
  let requestUrl = ""; let body = "";
  const token = await exchangeGoogleAuthorizationCode({ clientId: "client", clientSecret: "secret", redirectUri: "https://perskop.example/callback", code: "code", codeVerifier: "verifier", fetch: (async (url, init) => { requestUrl = String(url); body = String(init?.body); return Response.json({ access_token: "access", refresh_token: "refresh" }); }) as typeof fetch });
  assert.equal(token.refresh_token, "refresh"); assert.equal(requestUrl.includes("verifier"), false); assert.match(body, /code_verifier=verifier/);
});

test("Google OAuth state is encrypted and one-time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-google-oauth-")); const memory = new MemoryStore(dir); memory.db.prepare("INSERT INTO connector_accounts (id,owner_id,source,display_name,status) VALUES ('google-a','owner','google','Gmail','connected')").run();
  const store = new GoogleOAuthStateStore(memory.db, crypto.randomBytes(32).toString("base64")); store.save({ state: "state", accountId: "google-a", verifier: "verifier" });
  const raw = memory.db.prepare("SELECT verifier_ciphertext FROM oauth_pending_states").get() as { verifier_ciphertext: Buffer };
  assert.equal(raw.verifier_ciphertext.toString("utf8").includes("verifier"), false);
  assert.deepEqual(store.consume("state"), { accountId: "google-a", verifier: "verifier" }); assert.equal(store.consume("state"), null);
  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
