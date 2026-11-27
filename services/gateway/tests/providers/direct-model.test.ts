import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../../src/config.js";
import {
  callDirectModel,
  callDirectModelStreaming,
  DirectModelError,
} from "../../src/providers/directModel.js";

const config = {
  PERSKOP_LLM_PROXY_URL: "http://proxy/v1",
  PERSKOP_LLM_PROXY_SECRET: "secret",
  PERSKOP_LLM_TIMEOUT_MS: 30,
} as AppConfig;

function responseFrom(chunks: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("parses split lines, CRLF, DONE, returned model, usage, and streamed tokens", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseFrom([
    'data: {"model":"glm-returned","choices":[{"delta":{"content":"hel',
    'lo"}}]}\r\n\r\n',
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3},"choices":[{"delta":{}}]}\n\n',
    "data: [DONE]\r\n\r\n",
  ])) as typeof fetch;
  const tokens: string[] = [];
  try {
    const result = await callDirectModel(config, "hi", (token) => tokens.push(token));
    assert.equal(result.output, "hello");
    assert.equal(result.requestedModel, "glm-4.7-flash");
    assert.equal(result.returnedModel, "glm-returned");
    assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 1, totalTokens: 3 });
    assert.deepEqual(tokens, ["hello"]);
    assert.equal(await callDirectModelStreaming(config, "hi"), "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed JSON and EOF before DONE", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => responseFrom(["data: not-json\n\n"])) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), (error: any) => {
      assert.ok(error instanceof DirectModelError);
      assert.equal(error.failure.kind, "malformed_response");
      return true;
    });
    globalThis.fetch = (async () => responseFrom(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), /ended before \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("times out before headers and while reading the body", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), (error: any) => error.failure?.kind === "timeout");

    globalThis.fetch = (async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 200 })) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), (error: any) => error.failure?.kind === "timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("propagates explicit cancellation without misreporting a timeout", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(callDirectModel(config, "hi", undefined, { signal: controller.signal }), /cancelled/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes auth and rate-limit responses with Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("bad token", { status: 401 })) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), (error: any) => {
      assert.equal(error.failure.kind, "auth");
      assert.equal(error.failure.retryable, false);
      return true;
    });
    globalThis.fetch = (async () => new Response("quota", { status: 429, headers: { "Retry-After": "60" } })) as typeof fetch;
    await assert.rejects(callDirectModel(config, "hi"), (error: any) => {
      assert.equal(error.failure.kind, "rate_limit");
      assert.equal(error.failure.statusCode, 429);
      assert.ok(error.failure.cooldownUntil);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
