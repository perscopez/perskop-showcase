import test from "node:test";
import assert from "node:assert/strict";
import { GmailApiError, GmailClient } from "../../src/connectors/google/gmail.js";

test("Gmail client fetches profile, labels and paginated search threads", async () => {
  const calls: string[] = [];
  const client = new GmailClient({
    accessToken: "access-token",
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access-token");
      if (url.endsWith("/profile")) return Response.json({ emailAddress: "owner@example.com", messagesTotal: 10, threadsTotal: 8, historyId: "99" });
      if (url.endsWith("/labels")) return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
      if (!url.includes("pageToken=")) return Response.json({ threads: [{ id: "t1", snippet: "first" }], nextPageToken: "next", resultSizeEstimate: 2 });
      return Response.json({ threads: [{ id: "t2", snippet: "second" }], resultSizeEstimate: 2 });
    }) as typeof fetch,
  });

  assert.equal((await client.getProfile()).emailAddress, "owner@example.com");
  assert.equal((await client.listLabels())[0].id, "INBOX");
  const result = await client.listThreads({ q: "from:tu-dortmund.de", labelIds: ["INBOX"], maxResults: 2 });
  assert.deepEqual(result.threads.map((thread) => thread.id), ["t1", "t2"]);
  const firstList = new URL(calls.find((url) => url.includes("/threads?") && !url.includes("pageToken="))!);
  assert.equal(firstList.searchParams.get("q"), "from:tu-dortmund.de");
  assert.deepEqual(firstList.searchParams.getAll("labelIds"), ["INBOX"]);
});

test("Gmail client returns full threads, attachments and reversible mutations", async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const client = new GmailClient({
    accessToken: "access-token",
    fetch: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? String(init.body) : undefined });
      if (url.includes("/attachments/")) return Response.json({ data: "SGVsbG8", size: 5 });
      if (method === "POST") return Response.json({ id: "t1", labelIds: ["STARRED"] });
      return Response.json({ id: "t1", historyId: "101", messages: [{ id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "Hello", internalDate: "1784390000000", payload: { headers: [{ name: "Subject", value: "Test" }] } }] });
    }) as typeof fetch,
  });

  const thread = await client.getThread("t1");
  assert.equal(thread.messages[0].id, "m1");
  const attachment = await client.getAttachment("m1", "a1");
  assert.equal(attachment.data.toString("utf8"), "Hello");
  await client.modifyThread("t1", { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX"] });
  assert.ok(requests.some((request) => request.method === "POST" && request.url.endsWith("/threads/t1/modify") && request.body?.includes("STARRED")));
  await client.sendMessage({ raw: "cmF3", threadId: "t1" });
  assert.ok(requests.some((request) => request.url.endsWith("/messages/send") && request.body?.includes('"raw":"cmF3"') && request.body?.includes('"threadId":"t1"')));
});

test("Gmail client normalizes provider errors without leaking tokens", async () => {
  const client = new GmailClient({
    accessToken: "secret-access-token",
    fetch: (async () => Response.json({ error: { code: 403, message: "Gmail API has not been used", errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 })) as typeof fetch,
  });
  await assert.rejects(
    () => client.getProfile(),
    (error: unknown) => {
      assert.ok(error instanceof GmailApiError);
      assert.equal(error.status, 403);
      assert.equal(error.reason, "accessNotConfigured");
      assert.equal(error.message.includes("secret-access-token"), false);
      return true;
    },
  );
});

test("Gmail history pagination preserves the start cursor", async () => {
  const calls: string[] = [];
  const client = new GmailClient({
    accessToken: "access-token",
    fetch: (async (input) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("pageToken=")) {
        return Response.json({ history: [{ id: "101", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] }], nextPageToken: "next", historyId: "101" });
      }
      return Response.json({ history: [{ id: "102", labelsAdded: [{ message: { id: "m2", threadId: "t2" }, labelIds: ["STARRED"] }] }], historyId: "102" });
    }) as typeof fetch,
  });
  const result = await client.listHistory("100");
  assert.deepEqual(result.history.map((item) => item.id), ["101", "102"]);
  assert.equal(result.historyId, "102");
  assert.ok(calls.every((url) => new URL(url).searchParams.get("startHistoryId") === "100"));
});
