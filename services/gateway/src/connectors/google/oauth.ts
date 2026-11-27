import crypto from "node:crypto";
import type Database from "better-sqlite3";

export const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;

function base64url(value: Buffer) { return value.toString("base64url"); }

export function createGoogleOAuthRequest(input: { clientId: string; redirectUri: string }) {
  const state = base64url(crypto.randomBytes(32));
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: input.clientId, redirect_uri: input.redirectUri, response_type: "code", scope: GOOGLE_CALENDAR_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "false", state, code_challenge: codeChallenge, code_challenge_method: "S256" }).toString();
  return { url: url.toString(), state, codeVerifier };
}

export async function exchangeGoogleAuthorizationCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string; fetch?: typeof fetch }): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const response = await (input.fetch ?? fetch)("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, code: input.code, code_verifier: input.codeVerifier, grant_type: "authorization_code" }) });
  if (!response.ok) throw new Error(`Google OAuth token exchange failed (${response.status})`);
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!body.access_token) throw new Error("Google OAuth response is missing access_token");
  return { ...body, access_token: body.access_token };
}

export async function refreshGoogleAccessToken(input: { clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch }): Promise<{ access_token: string; expires_in?: number }> {
  const response = await (input.fetch ?? fetch)("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.refreshToken, grant_type: "refresh_token" }) });
  if (!response.ok) throw new Error(`Google OAuth refresh failed (${response.status})`);
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google OAuth refresh response is missing access_token");
  return { access_token: body.access_token, expires_in: body.expires_in };
}

export class GoogleOAuthStateStore {
  private readonly key: Buffer;
  constructor(
    private readonly db: Database.Database,
    masterKey: string,
    private readonly provider = "google",
  ) {
    this.key = Buffer.from(masterKey, "base64");
    if (this.key.length !== 32) throw new Error("PERSKOP_CONNECTOR_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  save(input: { state: string; accountId: string; verifier: string; expiresInMs?: number }) {
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.verifier, "utf8"), cipher.final()]); const authTag = cipher.getAuthTag();
    const stateHash = crypto.createHash("sha256").update(input.state).digest("hex");
    this.db.prepare(`INSERT INTO oauth_pending_states (state_hash,account_id,provider,verifier_ciphertext,verifier_nonce,verifier_auth_tag,expires_at) VALUES (?,?,?,?,?,?,?)`).run(stateHash, input.accountId, this.provider, ciphertext, nonce, authTag, new Date(Date.now() + (input.expiresInMs ?? 10 * 60_000)).toISOString());
  }
  consume(state: string) {
    const stateHash = crypto.createHash("sha256").update(state).digest("hex"); const row = this.db.prepare(`SELECT * FROM oauth_pending_states WHERE state_hash=? AND provider=? AND consumed_at IS NULL AND expires_at > ?`).get(stateHash, this.provider, new Date().toISOString()) as any;
    if (!row) return null;
    const update = this.db.prepare(`UPDATE oauth_pending_states SET consumed_at=datetime('now') WHERE state_hash=? AND consumed_at IS NULL`).run(stateHash);
    if (update.changes !== 1) return null;
    try { const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, row.verifier_nonce); decipher.setAuthTag(row.verifier_auth_tag); return { accountId: row.account_id as string, verifier: Buffer.concat([decipher.update(row.verifier_ciphertext), decipher.final()]).toString("utf8") }; } catch { throw new Error("Google OAuth state cannot be decrypted"); }
  }
}
