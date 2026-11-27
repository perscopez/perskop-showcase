import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ExecutionRegistry,
  buildContainerConfig,
  buildVerificationContainerConfig,
  normalizeTimeoutMs,
  redactedExecutionSummary,
} from "./profiles.mjs";
import {
  prepareRepositoryWorkspace,
  verifyRepositoryResult,
} from "./repository.mjs";

const PORT = process.env.PORT || 18788;
const EXECUTOR_TOKEN = process.env.PERSKOP_EXECUTOR_TOKEN;
const WORKSPACE_HOST_PATH = process.env.WORKSPACE_HOST_PATH || "/srv/perskop/workspace-staging";
const SANDBOX_NETWORK = process.env.PERSKOP_SANDBOX_NETWORK || "perskop_sandbox_internal";
const CREDENTIAL_ROOT =
  process.env.PERSKOP_CREDENTIAL_ROOT || "/srv/perskop/credentials";
const PROVIDER_PROXY_URL =
  process.env.PERSKOP_PROVIDER_PROXY_URL ||
  "http://provider-egress-proxy:18888";
const REPOSITORY_ROOT =
  process.env.PERSKOP_REPOSITORY_ROOT || "/repositories";
const PROVIDER_RUNTIME_ROOT =
  process.env.PERSKOP_PROVIDER_RUNTIME_ROOT || "/usr/local/lib/node_modules";
const executions = new ExecutionRegistry();

if (!EXECUTOR_TOKEN) {
  console.error("PERSKOP_EXECUTOR_TOKEN is required");
  process.exit(1);
}

// Helper to query local Docker socket
function dockerRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        method: options.method || "GET",
        path: options.path,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            reject(
              new Error(
                `Docker API error (${res.statusCode}): ${buffer.toString("utf8")}`,
              ),
            );
          } else {
            resolve({ statusCode: res.statusCode, body: buffer });
          }
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function demuxDockerStream(buffer) {
  // Docker logs multiplexing: 8-byte header (1 byte stream, 3 bytes null, 4 bytes big-endian length)
  let offset = 0;
  let text = "";
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const type = buffer.readUInt8(offset);
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break;
    const chunk = buffer.toString("utf8", offset, offset + size);
    text += chunk;
    offset += size;
  }
  return text || buffer.toString("utf8");
}

async function cleanupContainer(containerId, reason) {
  if (!containerId) return;
  console.log(`[Executor] Cleanup (${reason}): stopping ${containerId}`);
  try {
    await dockerRequest({ method: "POST", path: `/containers/${containerId}/stop?t=2` });
  } catch (error) {
    if (!String(error.message).includes("304") && !String(error.message).includes("404")) {
      console.warn(`[Executor] Cleanup stop warning: ${error.message}`);
    }
  }
  try {
    await dockerRequest({ method: "DELETE", path: `/containers/${containerId}?force=true&v=true` });
  } catch (error) {
    if (!String(error.message).includes("404")) throw error;
  }
}

function safeEphemeralWorkspace(taskId, requestedSubdir) {
  const subdir = requestedSubdir || String(taskId);
  if (!/^[a-zA-Z0-9_-]+$/.test(subdir)) throw new Error("Invalid workspaceSubdir");
  const resolved = path.resolve(WORKSPACE_HOST_PATH, subdir);
  if (!resolved.startsWith(`${path.resolve(WORKSPACE_HOST_PATH)}${path.sep}`)) {
    throw new Error("Workspace escapes staging root");
  }
  return resolved;
}

function chownTree(target, uid, gid) {
  fs.chownSync(target, uid, gid);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) chownTree(child, uid, gid);
    else fs.chownSync(child, uid, gid);
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

function tokenMatches(header) {
  if (typeof header !== "string") return false;
  const a = crypto.createHash("sha256").update(header).digest();
  const b = crypto.createHash("sha256").update(`Bearer ${EXECUTOR_TOKEN}`).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  // 1. Auth check (constant-time)
  const auth = req.headers["authorization"];
  if (!tokenMatches(auth)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // 2. Handle POST /execute
  if (req.method === "POST" && req.url === "/execute") {
    let bodyData = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      bodyData += chunk;
      if (bodyData.length > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let containerId = null;
      let taskId = null;
      let workspacePath = WORKSPACE_HOST_PATH;
      let ephemeralWorkspace = false;
      try {
        const payload = JSON.parse(bodyData);
        ({ taskId } = payload);
        ephemeralWorkspace = payload.profile === "coding";

        if (ephemeralWorkspace) {
          workspacePath = safeEphemeralWorkspace(taskId, payload.workspaceSubdir);
          if (payload.operation) {
            prepareRepositoryWorkspace({
              operation: payload.operation,
              repositoryRoot: REPOSITORY_ROOT,
              workspacePath,
            });
          } else {
            fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
          }
          fs.chmodSync(workspacePath, 0o700);
          chownTree(workspacePath, 1000, 1000);
        }

        const containerConfig = buildContainerConfig(payload, {
          workspaceRoot: WORKSPACE_HOST_PATH,
          credentialRoot: CREDENTIAL_ROOT,
          providerRuntimeRoot: PROVIDER_RUNTIME_ROOT,
          sandboxNetwork: SANDBOX_NETWORK,
          proxyUrl: PROVIDER_PROXY_URL,
        });
        console.log("[Executor] Spawning container", redactedExecutionSummary(payload));

        // A. Create container
        const createRes = await dockerRequest(
          { method: "POST", path: "/containers/create" },
          containerConfig,
        );
        containerId = JSON.parse(createRes.body.toString("utf8")).Id;
        executions.start(taskId, containerId);

        // B. Start container
        await dockerRequest({
          method: "POST",
          path: `/containers/${containerId}/start`,
        });

        // C. Wait for container with 15s timeout.
        // P7: On timeout, full cleanup sequence is guaranteed:
        //     1. docker stop (SIGTERM + 10s grace)
        //     2. docker rm -f
        //     3. Task state → timed_out
        //     4. Scoped token revocation happens in gateway (via revokeScopedTokensByTask)
        const timeoutMs = normalizeTimeoutMs(payload.timeoutMs);
        let timeoutHandle;
        const waitResult = await Promise.race([
          dockerRequest({ method: "POST", path: `/containers/${containerId}/wait` }),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(Object.assign(new Error(`Execution timed out after ${timeoutMs}ms`), { code: "TIMED_OUT" })),
              timeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timeoutHandle));

        const exitCode = JSON.parse(waitResult.body.toString("utf8")).StatusCode;
        if (executions.wasCancelled(taskId)) {
          throw new Error("Execution cancelled");
        }

        // D. Get logs
        const logsRes = await dockerRequest({
          method: "GET",
          path: `/containers/${containerId}/logs?stdout=true&stderr=true`,
        });
        const cleanOutput = demuxDockerStream(logsRes.body);
        let verification = payload.operation
          ? verifyRepositoryResult({
              operation: payload.operation,
              workspacePath,
            })
          : undefined;
        if (executions.wasCancelled(taskId)) {
          throw new Error("Execution cancelled");
        }

        // E. Delete container
        await dockerRequest({
          method: "DELETE",
          path: `/containers/${containerId}?v=true`,
        });
        executions.finish(taskId);
        containerId = null;

        if (payload.operation) {
          const verificationConfig = buildVerificationContainerConfig(
            payload,
            {
              workspaceRoot: WORKSPACE_HOST_PATH,
              credentialRoot: CREDENTIAL_ROOT,
              providerRuntimeRoot: PROVIDER_RUNTIME_ROOT,
              sandboxNetwork: SANDBOX_NETWORK,
              proxyUrl: PROVIDER_PROXY_URL,
            },
          );
          const verificationCreate = await dockerRequest(
            { method: "POST", path: "/containers/create" },
            verificationConfig,
          );
          containerId = JSON.parse(
            verificationCreate.body.toString("utf8"),
          ).Id;
          executions.start(taskId, containerId);
          await dockerRequest({
            method: "POST",
            path: `/containers/${containerId}/start`,
          });
          let verificationTimeout;
          const verificationWait = await Promise.race([
            dockerRequest({
              method: "POST",
              path: `/containers/${containerId}/wait`,
            }),
            new Promise((_, reject) => {
              verificationTimeout = setTimeout(
                () =>
                  reject(
                    Object.assign(
                      new Error(
                        `Verification timed out after ${timeoutMs}ms`,
                      ),
                      { code: "TIMED_OUT" },
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]).finally(() => clearTimeout(verificationTimeout));
          const verificationExitCode = JSON.parse(
            verificationWait.body.toString("utf8"),
          ).StatusCode;
          if (executions.wasCancelled(taskId)) {
            throw new Error("Execution cancelled");
          }
          const verificationLogs = await dockerRequest({
            method: "GET",
            path: `/containers/${containerId}/logs?stdout=true&stderr=true`,
          });
          const verificationOutput = demuxDockerStream(
            verificationLogs.body,
          ).slice(0, 16_384);
          await dockerRequest({
            method: "DELETE",
            path: `/containers/${containerId}?v=true`,
          });
          executions.finish(taskId);
          containerId = null;
          if (
            verificationExitCode !== payload.operation.expectedExitCode
          ) {
            throw new Error(
              `Verification exit mismatch: expected ${payload.operation.expectedExitCode}, got ${verificationExitCode}`,
            );
          }
          verification = {
            ...verification,
            verificationExitCode,
            verificationOutput,
          };
        }

        if (ephemeralWorkspace) fs.rmSync(workspacePath, { recursive: true, force: true });

        // F. Return results
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            exitCode,
            output: cleanOutput,
            ...(verification ? { verification } : {}),
          }),
        );
      } catch (err) {
        const wasCancelled =
          taskId != null && executions.wasCancelled(taskId);
        console.error(wasCancelled ? "[Executor] Execution cancelled:" : "[Executor] Execution failed:", err.message);

        // P7: Full cleanup on any failure (timeout or error).
        if (containerId && !wasCancelled) {
          const cid = containerId;
          containerId = null;
          try {
            await cleanupContainer(cid, err.code === "TIMED_OUT" ? "timeout" : "error");
          } catch (cleanupError) {
            console.error(`[Executor] Cleanup failed: ${cleanupError.message}`);
          }
        }

        if (taskId != null) executions.finish(taskId);
        if (ephemeralWorkspace) fs.rmSync(workspacePath, { recursive: true, force: true });

        const status = wasCancelled ? 409 : err.code === "TIMED_OUT" ? 504 : 500;
        const taskState = wasCancelled ? "cancelled" : err.code === "TIMED_OUT" ? "timed_out" : "error";
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: wasCancelled ? "Execution cancelled" : err.message,
          taskState,
        }));

      }
    });
  } else if (req.method === "POST" && req.url?.startsWith("/cancel/")) {
    const taskId = decodeURIComponent(req.url.slice("/cancel/".length));
    const containerId = executions.get(taskId);
    if (containerId) {
      try {
        executions.cancel(taskId);
        await cleanupContainer(containerId, "cancellation");
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, taskId, cancelled: Boolean(containerId) }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sandbox Executor Service listening on 0.0.0.0:${PORT}`);
});
