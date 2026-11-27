import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { GmailApiError, type GmailClient, type GmailThread } from "../../src/connectors/google/gmail.js";
import { GmailStore } from "../../src/email/gmailStore.js";
import { syncGmailAccount } from "../../src/email/gmailSync.js";

function thread(subject: string, id = "t1"): GmailThread {
  return {
    id,
    historyId: "101",
    messages: [{
      id: `m-${id}`,
      threadId: id,
      labelIds: ["INBOX", "UNREAD"],
      snippet: subject,
      internalDate: "1784390000000",
      payload: {
        headers: [
          { name: "Subject", value: subject },
          { name: "From", value: "admission.inquiries@tu-dortmund.de" },
          { name: "Message-ID", value: `<${id}@example>` },
        ],
        mimeType: "text/plain",
        body: { data: Buffer.from(`Body ${subject}`).toString("base64url"), size: 20 },
      },
    }],
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-gmail-sync-"));
  const memory = new MemoryStore(dir);
  memory.db.prepare("INSERT INTO connector_accounts (id,owner_id,source,display_name,status) VALUES ('mail-a','owner','google_mail','Gmail','connected')").run();
  return { dir, memory };
}

test("initial Gmail sync materializes profile, labels, threads, messages and classification", async () => {
  const { dir, memory } = setup();
  const client = {
    getProfile: async () => ({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "101" }),
    listLabels: async () => [{ id: "INBOX", name: "INBOX", type: "system" as const }],
    listThreads: async () => ({ threads: [{ id: "t1" }], resultSizeEstimate: 1 }),
    getThread: async () => thread("University application documents"),
  } as unknown as GmailClient;

  const result = await syncGmailAccount({ memory, client, accountId: "mail-a" });
  assert.equal(result.mode, "full");
  assert.equal(result.threadCount, 1);
  const store = new GmailStore(memory.db);
  assert.equal(store.getAccount("mail-a")?.emailAddress, "owner@example.com");
  const row = store.listThreads({ accountId: "mail-a" })[0];
  assert.equal(row.category, "priority");
  assert.equal(row.hidden, false);
  assert.ok(row.reasons.includes("university"));
  assert.equal(store.getThread("mail-a", "t1")?.messages[0].rfcMessageId, "<t1@example>");

  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("incremental Gmail sync refreshes only affected threads", async () => {
  const { dir, memory } = setup();
  let subject = "Old subject";
  const client = {
    getProfile: async () => ({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "101" }),
    listLabels: async () => [{ id: "INBOX", name: "INBOX", type: "system" as const }],
    listThreads: async () => ({ threads: [{ id: "t1" }], resultSizeEstimate: 1 }),
    listHistory: async () => ({ history: [{ id: "102", messagesAdded: [{ message: { id: "m-t1", threadId: "t1" } }] }], historyId: "102" }),
    getThread: async () => thread(subject),
  } as unknown as GmailClient;
  await syncGmailAccount({ memory, client, accountId: "mail-a" });
  subject = "Visa appointment action required";
  const result = await syncGmailAccount({ memory, client, accountId: "mail-a" });
  assert.equal(result.mode, "incremental");
  assert.equal(new GmailStore(memory.db).listThreads({ accountId: "mail-a" })[0].category, "urgent");
  assert.equal(new GmailStore(memory.db).getAccount("mail-a")?.historyId, "102");

  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("expired Gmail history cursor falls back to bounded full sync", async () => {
  const { dir, memory } = setup();
  const store = new GmailStore(memory.db);
  store.upsertAccount({ accountId: "mail-a", emailAddress: "owner@example.com", historyId: "expired" });
  let fullListCalls = 0;
  const client = {
    getProfile: async () => ({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "200" }),
    listLabels: async () => [],
    listHistory: async () => { throw new GmailApiError(404, "historyIdInvalid", "History expired"); },
    listThreads: async () => { fullListCalls += 1; return { threads: [{ id: "t1" }], resultSizeEstimate: 1 }; },
    getThread: async () => thread("Recovered thread"),
  } as unknown as GmailClient;
  const result = await syncGmailAccount({ memory, client, accountId: "mail-a", maxThreads: 25 });
  assert.equal(result.mode, "full");
  assert.equal(result.recoveredFromExpiredHistory, true);
  assert.equal(fullListCalls, 1);
  assert.equal(store.getAccount("mail-a")?.historyId, "200");

  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("persisted sender rules immediately reclassify cached Gmail threads and future syncs", async () => {
  const { dir, memory } = setup();
  const client = {
    getProfile: async () => ({ emailAddress: "owner@example.com", messagesTotal: 1, threadsTotal: 1, historyId: "101" }),
    listLabels: async () => [],
    listThreads: async () => ({ threads: [{ id: "t1" }], resultSizeEstimate: 1 }),
    getThread: async () => thread("University application documents"),
  } as unknown as GmailClient;
  await syncGmailAccount({ memory, client, accountId: "mail-a" });
  const store = new GmailStore(memory.db);
  store.upsertSenderRule({ pattern: "@tu-dortmund.de", action: "promotion" });
  assert.equal(store.listThreads({ accountId: "mail-a" }).length, 0);
  assert.equal(store.listThreads({ accountId: "mail-a", includeHidden: true })[0].category, "promotion");
  assert.deepEqual(store.listSenderRules(), [{ pattern: "@tu-dortmund.de", action: "promotion" }]);

  store.upsertSenderRule({ pattern: "@tu-dortmund.de", action: "important" });
  assert.equal(store.listThreads({ accountId: "mail-a" })[0].category, "priority");
  assert.equal(store.deleteSenderRule("@tu-dortmund.de"), 1);
  assert.equal(store.listThreads({ accountId: "mail-a" })[0].category, "priority");

  memory.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
