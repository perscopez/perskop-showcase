import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(serviceDir, "../..");

test("container runs as a fixed non-root user", () => {
  const dockerfile = fs.readFileSync(path.join(serviceDir, "Dockerfile"), "utf8");
  assert.match(dockerfile, /adduser[^\n]+-u 10001/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /USER root/);
});

test("compose hardens the proxy and keeps sandbox workloads off external egress", () => {
  const compose = fs.readFileSync(path.join(repoDir, "docker-compose.perskop.yml"), "utf8");
  const proxy = compose.match(/\n  provider-egress-proxy:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|\nnetworks:\n)/)?.[1] ?? "";
  const sandbox = compose.match(/\n  sandbox-executor:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|\nnetworks:\n)/)?.[1] ?? "";
  assert.match(proxy, /read_only: true/);
  assert.match(proxy, /no-new-privileges:true/);
  assert.match(proxy, /cap_drop:\n\s+- ALL/);
  assert.match(proxy, /mem_limit: 128m/);
  assert.match(proxy, /pids_limit: 64/);
  assert.match(proxy, /perskop_sandbox_internal/);
  assert.match(proxy, /perskop_provider_external/);
  assert.match(sandbox, /perskop_sandbox_internal/);
  assert.doesNotMatch(sandbox, /perskop_provider_external/);
  assert.match(compose, /perskop_sandbox_internal:\n\s+name: perskop_sandbox_internal\n\s+internal: true/);
});
