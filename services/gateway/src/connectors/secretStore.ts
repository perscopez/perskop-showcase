import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { ConnectorAccount } from "./types.js";

export type ConnectorSecretKind =
  | "icloud_username"
  | "icloud_app_password"
  | "google_oauth_client_id"
  | "google_oauth_client_secret"
  | "google_oauth_redirect_uri"
  | "google_refresh_token"
  | "google_access_token"
  | "google_access_expires_at";

type SecretRecord = {
  account_id: string;
  secret_kind: ConnectorSecretKind;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
};

function keyFromBase64(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("PERSKOP_CONNECTOR_MASTER_KEY must be a base64-encoded 32-byte key");
  return key;
}

/** Keeps connector credentials in SQLite only as AES-256-GCM ciphertext. */
export class ConnectorSecretStore {
  private readonly key: Buffer | undefined;

  constructor(private readonly db: Database.Database, masterKey?: string) {
    this.key = keyFromBase64(masterKey);
  }

  put(input: { accountId: string; kind: ConnectorSecretKind; value: string; keyId?: string }) {
    const key = this.requireKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.db.prepare(`
      INSERT INTO connector_secrets (account_id, secret_kind, key_id, nonce, ciphertext, auth_tag, updated_at)
      VALUES (@accountId, @kind, @keyId, @nonce, @ciphertext, @authTag, datetime('now'))
      ON CONFLICT(account_id, secret_kind) DO UPDATE SET
        key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag, updated_at = excluded.updated_at
    `).run({ accountId: input.accountId, kind: input.kind, keyId: input.keyId ?? "v1", nonce, ciphertext, authTag });
  }

  get(accountId: string, kind: ConnectorSecretKind): string | null {
    const row = this.db.prepare(`
      SELECT account_id, secret_kind, key_id, nonce, ciphertext, auth_tag
      FROM connector_secrets WHERE account_id = ? AND secret_kind = ?
    `).get(accountId, kind) as SecretRecord | undefined;
    if (!row) return null;
    const key = this.requireKey();
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, row.nonce);
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("connector secret cannot be decrypted with the configured master key");
    }
  }

  has(accountId: string, kind: ConnectorSecretKind): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM connector_secrets WHERE account_id = ? AND secret_kind = ?").get(accountId, kind));
  }

  deleteAccount(accountId: string): number {
    return this.db.prepare("DELETE FROM connector_secrets WHERE account_id = ?").run(accountId).changes;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error("connector master key is required when encrypted connector secrets exist");
    return this.key;
  }
}

/** Connector account contracts deliberately contain no credential-bearing field. */
export function redactConnectorAccount(account: ConnectorAccount): ConnectorAccount {
  return { ...account };
}
