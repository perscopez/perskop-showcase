import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderFailure } from "../../src/providers/errors.js";

const NOW = Date.parse("2026-07-14T16:00:00.000Z");

test("normalizes HTTP 429 and numeric Retry-After", () => {
  const failure = normalizeProviderFailure({
    statusCode: 429,
    retryAfter: "120",
    message: 'Rate limit reached: Bearer super-secret-token',
  }, NOW);

  assert.equal(failure.kind, "rate_limit");
  assert.equal(failure.retryable, true);
  assert.equal(failure.cooldownUntil, "2026-07-14T16:02:00.000Z");
  assert.doesNotMatch(failure.message, /super-secret-token/);
});

test("normalizes HTTP-date Retry-After", () => {
  const failure = normalizeProviderFailure({
    status: 429,
    retryAfter: "Tue, 14 Jul 2026 16:03:00 GMT",
    message: "quota exceeded",
  }, NOW);

  assert.equal(failure.kind, "rate_limit");
  assert.equal(failure.cooldownUntil, "2026-07-14T16:03:00.000Z");
});

test("normalizes authentication failures as non-retryable", () => {
  const failure = normalizeProviderFailure({ statusCode: 401, message: "invalid api_key=abc123" }, NOW);
  assert.equal(failure.kind, "auth");
  assert.equal(failure.retryable, false);
  assert.doesNotMatch(failure.message, /abc123/);
});

test("normalizes timeout and transport failures", () => {
  const timeout = normalizeProviderFailure(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }), NOW);
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.retryable, true);

  const transport = normalizeProviderFailure(Object.assign(new Error("getaddrinfo ENOTFOUND provider"), { code: "ENOTFOUND" }), NOW);
  assert.equal(transport.kind, "transport");
  assert.equal(transport.retryable, true);
});

test("normalizes malformed streams separately", () => {
  const failure = normalizeProviderFailure(new Error("Model proxy stream ended before [DONE]"), NOW);
  assert.equal(failure.kind, "malformed_response");
  assert.equal(failure.retryable, true);
});

test("normalizes missing CLI as provider unavailable", () => {
  const failure = normalizeProviderFailure({ exitCode: 127, message: "command not found" }, NOW);
  assert.equal(failure.kind, "provider_unavailable");
  assert.equal(failure.retryable, false);
  assert.equal(failure.exitCode, 127);
});

test("keeps unknown failures explicit", () => {
  const failure = normalizeProviderFailure({ exitCode: 42, message: "unexpected failure" }, NOW);
  assert.equal(failure.kind, "unknown");
  assert.equal(failure.retryable, false);
  assert.equal(failure.statusCode, undefined);
  assert.equal(failure.exitCode, 42);
});
