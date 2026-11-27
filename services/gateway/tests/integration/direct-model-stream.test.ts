import test from "node:test";
import assert from "node:assert/strict";
import { callDirectModelStreaming } from "../../src/providers/router.js";
import type { AppConfig } from "../../src/config.js";

const config = {
  PERSKOP_LLM_PROXY_URL: "http://proxy/v1",
  PERSKOP_LLM_PROXY_SECRET: "secret",
  PERSKOP_LLM_TIMEOUT_MS: 25,
} as AppConfig;

function responseFrom(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("direct model stops at DONE and reports streamed tokens", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    responseFrom([
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ])) as typeof fetch;
  const tokens: string[] = [];
  try {
    assert.equal(await callDirectModelStreaming(config, "hi", (token) => tokens.push(token)), "hello");
    assert.deepEqual(tokens, ["hel", "lo"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct model rejects malformed or interrupted SSE", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => responseFrom(["data: not-json\n\n"])) as typeof fetch;
    await assert.rejects(callDirectModelStreaming(config, "hi"), /Malformed SSE/);
    globalThis.fetch = (async () => responseFrom(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])) as typeof fetch;
    await assert.rejects(callDirectModelStreaming(config, "hi"), /ended before \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct model aborts an upstream that never returns headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  try {
    await assert.rejects(callDirectModelStreaming(config, "hi"), /timed out after 25ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
