import test from "node:test";
import assert from "node:assert/strict";
import { runGmailBackgroundSync } from "../../src/email/gmailScheduler.js";

test("background Gmail sync discovers only connected accounts and isolates failures", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/oauth/status")) return Response.json({ accounts: [
      { id: "mail one", status: "connected" },
      { id: "mail-disabled", status: "disabled" },
      { id: "mail-two", status: "connected" },
    ] });
    if (url.includes("mail%20one")) return Response.json({ sync: { mode: "incremental", threadCount: 2 } });
    return Response.json({ error: "gmail_api_not_enabled" }, { status: 503 });
  };

  const results = await runGmailBackgroundSync({
    baseUrl: "http://127.0.0.1:8787",
    apiToken: "private-token",
    fetch: fakeFetch as typeof fetch,
  });
  assert.deepEqual(results, [
    { accountId: "mail one", ok: true, mode: "incremental", threadCount: 2 },
    { accountId: "mail-two", ok: false, error: "gmail_api_not_enabled" },
  ]);
  assert.equal(requests.some((request) => request.url.includes("mail-disabled")), false);
  assert.equal(requests.every((request) => request.init?.headers && JSON.stringify(request.init.headers).includes("private-token")), true);
  assert.equal(requests.filter((request) => request.init?.method === "POST").length, 2);
});
