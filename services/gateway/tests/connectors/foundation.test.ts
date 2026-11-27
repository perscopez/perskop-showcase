import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import {
  ConnectorSecretStore,
  redactConnectorAccount,
} from "../../src/connectors/secretStore.js";
import { normalizedCalendarEventId } from "../../src/connectors/calendar/normalization.js";
import type { ConnectorAccount } from "../../src/connectors/types.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-calendar-foundation-"));
  return { dir, store: new MemoryStore(dir) };
}

test("normalized calendar identity is stable and source scoped", () => {
  assert.equal(
    normalizedCalendarEventId({ source: "icloud", accountId: "a", calendarId: "c", sourceEventId: "e" }),
    normalizedCalendarEventId({ source: "icloud", accountId: "a", calendarId: "c", sourceEventId: "e" }),
  );
  assert.notEqual(
    normalizedCalendarEventId({ source: "icloud", accountId: "a", calendarId: "c", sourceEventId: "e" }),
    normalizedCalendarEventId({ source: "google", accountId: "a", calendarId: "c", sourceEventId: "e" }),
  );
});

test("connector secrets are encrypted, redacted, and fail closed without the master key", () => {
  const { dir, store } = fixture();
  const key = crypto.randomBytes(32).toString("base64");
  store.db.prepare(`
    INSERT INTO connector_accounts (id, owner_id, source, display_name, status)
    VALUES ('icloud-owner', 'owner', 'icloud', 'iCloud', 'connected')
  `).run();
  const secrets = new ConnectorSecretStore(store.db, key);
  secrets.put({ accountId: "icloud-owner", kind: "icloud_app_password", value: "super-secret" });

  assert.equal(secrets.get("icloud-owner", "icloud_app_password"), "super-secret");
  assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM connector_secrets").all()).includes("super-secret"), false);
  assert.throws(() => new ConnectorSecretStore(store.db).get("icloud-owner", "icloud_app_password"), /master key/i);
  assert.throws(
    () => new ConnectorSecretStore(store.db, crypto.randomBytes(32).toString("base64")).get("icloud-owner", "icloud_app_password"),
    /cannot be decrypted/i,
  );

  const account: ConnectorAccount = {
    id: "icloud-owner", ownerId: "owner", source: "icloud", displayName: "iCloud", status: "connected",
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
  };
  assert.deepEqual(redactConnectorAccount(account), account);
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("calendar foundation migrations create isolated registry tables", () => {
  const { dir, store } = fixture();
  const tables = new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of ["connector_accounts", "connector_secrets", "calendar_calendars", "calendar_events", "calendar_sync_state", "calendar_operations", "calendar_idempotency"]) {
    assert.equal(tables.has(table), true, table);
  }
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
