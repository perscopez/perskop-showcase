import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../db.js";
import {
  PROVIDER_NAMES,
  providerStatus,
  routePrompt,
  classifyPrompt,
  type ProviderName,
} from "../providers/router.js";
import { runEmailSync } from "../email/syncWorker.js";
import { canonicalize } from "../utils/jcs.js";
import {
  canonicalRepositoryApproval,
  equalApprovalHash,
  hashCanonicalApproval,
  repositoryOperationSchema,
  type RepositoryOperation,
} from "../security/repositoryApproval.js";
import { registerCalendarRoutes } from "./calendarRoutes.js";
import { registerMailRoutes } from "./mailRoutes.js";
import { conversationMemoryContent, redactConversationSecrets } from "../memory/conversation.js";
import { MemoryService } from "../memory/memoryService.js";
import { buildContextPackage } from "../memory/contextBuilder.js";
import { registerRemoteRoutes } from "./remoteRoutes.js";
import { registerNodeRoutes } from "./nodeRoutes.js";
import { TaskService, type TaskTransitionFields } from "../tasks/taskService.js";
import type { TaskStatus } from "../tasks/stateMachine.js";
import { buildRuntimeStatus } from "../runtime/status.js";

function authHook(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : (request.headers["x-perskop-token"] as string | undefined);

    if (!token || !safeTokenEqual(token, config.PERSKOP_API_TOKEN)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

function safeTokenEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const memoryBodySchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.enum(["mac", "telegram", "system"]).default("mac"),
  provider: z.string().nullable().optional(),
  projectId: z.string().min(1).optional(),
  memoryType: z.string().min(1).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const chatBodySchema = z.object({
  prompt: z.string().min(1),
  provider: z.enum(PROVIDER_NAMES).optional(),
  approved: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
  approvalId: z.string().optional(),
  operation: repositoryOperationSchema.optional(),
});

function canonicalApprovalRequest(input: {
  workload: string;
  taskId: number;
  prompt: string;
  nonce: string;
  operation?: RepositoryOperation;
}): { canonicalPayload: string; payloadHash: string } {
  if (input.workload === "repository_write") {
    if (!input.operation) throw new Error("repository_write requires a fully specified operation payload");
    const canonicalPayload = canonicalRepositoryApproval({
      taskId: input.taskId,
      nonce: input.nonce,
      operation: input.operation,
    });
    return { canonicalPayload, payloadHash: hashCanonicalApproval(canonicalPayload) };
  }
  const canonicalPayload = canonicalize({
    schemaVersion: 1,
    operationType: input.workload,
    taskId: input.taskId,
    prompt: input.prompt,
    nonce: input.nonce,
  });
  return { canonicalPayload, payloadHash: hashCanonicalApproval(canonicalPayload) };
}

function approvalMatchesRequest(
  approval: NonNullable<ReturnType<MemoryStore["getApproval"]>>,
  prompt: string,
  operation?: RepositoryOperation,
): boolean {
  try {
    const candidate = canonicalApprovalRequest({
      workload: approval.operation_type,
      taskId: approval.task_id,
      prompt,
      nonce: approval.nonce,
      operation,
    });
    return equalApprovalHash(candidate.payloadHash, approval.payload_hash);
  } catch {
    return false;
  }
}

const cloudProviderSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
});

export async function registerApiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  memory: MemoryStore,
) {
  const requireAuth = authHook(config);
  const taskService = new TaskService(memory);
  const transitionTask = (taskId: number, to: TaskStatus, fields?: TaskTransitionFields) => {
    const row = memory.db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId) as { revision: number } | undefined;
    if (!row) throw new Error("task_not_found");
    return taskService.transition(taskId, { to, expectedRevision: row.revision, fields });
  };
  registerCalendarRoutes(app, requireAuth, memory, {
    masterKey: config.PERSKOP_CONNECTOR_MASTER_KEY,
    googleOAuth: config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET && config.GOOGLE_OAUTH_REDIRECT_URI
      ? { clientId: config.GOOGLE_OAUTH_CLIENT_ID, clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: config.GOOGLE_OAUTH_REDIRECT_URI }
      : undefined,
  });
  registerMailRoutes(app, requireAuth, memory, {
    masterKey: config.PERSKOP_CONNECTOR_MASTER_KEY,
  });
  registerRemoteRoutes(app, requireAuth, memory);
  registerNodeRoutes(app, requireAuth, memory);

  app.get("/api/health", async () => ({
    ok: true,
    service: "perskop-gateway",
    telegram: Boolean(config.TELEGRAM_BOT_TOKEN),
  }));

  app.get("/api/status", { preHandler: requireAuth }, async () => ({
    ok: true,
    providers: providerStatus(config, memory.getCloudProvider() ?? undefined),
    memoryCount: memory.listMemories(1).length,
    recentTasks: memory.listTasks(5),
    runtime: buildRuntimeStatus(memory),
  }));

  app.get("/api/providers/default", { preHandler: requireAuth }, async () => ({
    provider: memory.getCloudProvider() ?? config.DEFAULT_PROVIDER,
  }));

  app.patch("/api/providers/default", { preHandler: requireAuth }, async (request) => {
    const body = cloudProviderSchema.parse(request.body);
    memory.setCloudProvider(body.provider);
    return { ok: true, provider: body.provider };
  });

  app.get("/api/memory", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { limit?: string; q?: string; projectId?: string };
    const limit = Number(query.limit ?? 20);
    const service = new MemoryService(memory);
    if (query.q) {
      return {
        items: memory.searchMemories(query.q, limit).map((row) => service.map(row)).filter(Boolean),
      };
    }
    return { items: service.listActive({ projectId: query.projectId, limit }) };
  });

  app.post("/api/memory", { preHandler: requireAuth }, async (request, reply) => {
    const body = memoryBodySchema.parse(request.body);
    try {
      const saved = new MemoryService(memory).save({
        source: body.source,
        title: body.title,
        content: body.content,
        projectId: body.projectId,
        memoryType: body.memoryType,
        provider: body.provider,
        expiresAt: body.expiresAt,
        provenance: { channel: "api", reason: "explicit_save" },
        dedupeKey: `owner:${body.projectId || "global"}:${body.memoryType || "note"}:${body.title}`.toLowerCase(),
      });
      return { item: saved.row, duplicate: saved.duplicate };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("secret_like")) return reply.code(400).send({ error: message });
      throw error;
    }
  });

  app.post("/api/memory/:id/pin", { preHandler: requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({ pinned: z.boolean().default(true) }).parse(request.body ?? {});
    const row = new MemoryService(memory).pin(id, body.pinned);
    if (!row || row.deleted_at) return reply.code(404).send({ error: "memory_not_found" });
    return { item: row };
  });

  app.post("/api/memory/:id/correct", { preHandler: requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = z.object({
      title: z.string().min(1).optional(),
      content: z.string().min(1),
    }).parse(request.body);
    try {
      const row = new MemoryService(memory).correct(id, {
        title: body.title,
        content: body.content,
        provenance: { channel: "api", reason: "user_correction" },
      });
      return { item: row };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "memory_not_found") return reply.code(404).send({ error: message });
      if (message.includes("secret_like")) return reply.code(400).send({ error: message });
      throw error;
    }
  });

  app.post("/api/memory/:id/delete", { preHandler: requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = new MemoryService(memory).softDelete(id);
    if (!row) return reply.code(404).send({ error: "memory_not_found" });
    return { item: row, deleted: true };
  });

  app.get("/api/memory/context", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { projectId?: string; budgetChars?: string };
    const service = new MemoryService(memory);
    const items = service.listActive({ projectId: query.projectId ?? "global", limit: 40 });
    return buildContextPackage(items, {
      userId: "owner",
      projectId: query.projectId ?? "global",
      budgetChars: query.budgetChars ? Number(query.budgetChars) : undefined,
    });
  });

  app.post("/api/chat", { preHandler: requireAuth }, async (request, reply) => {
    const body = chatBodySchema.parse(request.body);
    // A validated repository operation is authoritative. Patch contents may
    // legitimately contain words such as "status" that belong to other prompt
    // classes and must not bypass approval.
    const workload = body.operation ? "repository_write" : classifyPrompt(body.prompt);

    // Check if client requested event stream
    const isSSE =
      request.headers["accept"] === "text/event-stream" ||
      (body as any).stream === true;

    const needsApproval = ["repository_write", "shell_action", "calendar_write", "email_write"].includes(
      workload,
    );

    if (isSSE) {
      // Setup SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sendEvent = (event: string, data: any) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let taskId = 0;
      let finalTaskId = 0;
      try {
        if (needsApproval && !body.approvalId) {
          taskId = memory.addTask({
            source: "mac",
            prompt: body.prompt,
            provider: body.provider ?? null,
            status: "pending",
          });
          transitionTask(taskId, "queued", { workload });

          const nonce = crypto.randomBytes(16).toString("hex");
          let binding;
          try {
            binding = canonicalApprovalRequest({ workload, taskId, prompt: body.prompt, nonce, operation: body.operation });
          } catch (error) {
            transitionTask(taskId, "failed", { error: String(error) });
            sendEvent("error", { error: String(error) });
            reply.raw.end();
            return;
          }
          const { canonicalPayload, payloadHash: hash } = binding;
          const approvalId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

          memory.createApproval({
            id: approvalId,
            taskId,
            requestedBy: "mac",
            channelId: "api",
            sessionId: "default",
            operationType: workload,
            canonicalPayload,
            payloadHash: hash,
            expiresAt,
            nonce,
          });
          memory.updateTask(taskId, { approval_id: approvalId });

          sendEvent("awaiting_approval", {
            requiresApproval: true,
            approvalId,
            payloadHash: hash,
            nonce,
            prompt: `Destructive or service-altering operation (${workload}) requested.`,
          });
          reply.raw.end();
          return;
        }

        // If approval is provided, claim it
        finalTaskId = taskId;
        if (body.approvalId) {
          const approval = memory.getApproval(body.approvalId);
          if (!approval || !approvalMatchesRequest(approval, body.prompt, body.operation)) {
            sendEvent("error", { error: "Approval payload does not match the stored operation" });
            reply.raw.end();
            return;
          }
          const claimed = memory.claimApproval(body.approvalId);
          if (!claimed) {
            sendEvent("error", { error: "Approval invalid, expired or already claimed" });
            reply.raw.end();
            return;
          }
          const appr = memory.getApproval(body.approvalId)!;
          finalTaskId = appr.task_id;
          transitionTask(finalTaskId, "running");
        } else {
          finalTaskId = memory.addTask({
            source: "mac",
            prompt: body.prompt,
            provider: body.provider ?? null,
            status: "pending",
          });
          transitionTask(finalTaskId, "running", { workload });
        }

        sendEvent("task_status", { taskId: finalTaskId, status: "running" });

        // Route with streaming token callback
        const result = await routePrompt(
          config,
          body.prompt,
          body.provider,
          {
            memory,
            userId: "owner",
            projectId: config.DATA_DIR,
            approved: true,
            taskId: finalTaskId,
            workload,
            operation: body.operation,
          },
          (token) => {
            sendEvent("token", { token });
          },
        );

        if (memory.getTaskStatus(finalTaskId) === "cancelled") {
          throw new Error("Task was cancelled before completion");
        }

        const completion = transitionTask(finalTaskId, "done", {
          response: result.output,
          provider: result.provider,
        });
        if (!completion.applied) throw new Error(`Task completion discarded: ${completion.reason}`);

        if (body.approvalId) {
          memory.setApprovalStatus(body.approvalId, "consumed");
        }

        const item = memory.addMemory({
          source: "mac",
          title: redactConversationSecrets(body.prompt).slice(0, 80),
          content: conversationMemoryContent({ prompt: body.prompt, response: result.output, provider: result.provider }),
          provider: result.provider,
          memoryType: "conversation",
        });

        sendEvent("done", {
          taskId: finalTaskId,
          provider: result.provider,
          output: result.output,
          requestedModel: result.requestedModel,
          returnedModel: result.returnedModel,
          usage: result.usage,
          verification: result.verification,
          memory: item,
        });
        reply.raw.end();
      } catch (err: any) {
        const failedTaskId = finalTaskId || taskId;
        if (body.approvalId) {
          memory.setApprovalStatus(body.approvalId, "consumed");
        }
        if (failedTaskId && memory.getTaskStatus(failedTaskId) !== "cancelled") {
          transitionTask(failedTaskId, err?.sandboxTimedOut ? "timed_out" : "failed", {
            error: err.message,
          });
        }
        sendEvent("error", { error: err.message || String(err) });
        reply.raw.end();
      }
      return;
    }

    // --- Non-SSE Flow ---
    if (needsApproval && !body.approvalId) {
      const taskId = memory.addTask({
        source: "mac",
        prompt: body.prompt,
        provider: body.provider ?? null,
        status: "pending",
      });
      transitionTask(taskId, "queued", { workload });

      const nonce = crypto.randomBytes(16).toString("hex");
      let binding;
      try {
        binding = canonicalApprovalRequest({ workload, taskId, prompt: body.prompt, nonce, operation: body.operation });
      } catch (error) {
        transitionTask(taskId, "failed", { error: String(error) });
        return reply.code(400).send({ error: String(error) });
      }
      const { canonicalPayload, payloadHash: hash } = binding;
      const approvalId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      memory.createApproval({
        id: approvalId,
        taskId,
        requestedBy: "mac",
        channelId: "api",
        sessionId: "default",
        operationType: workload,
        canonicalPayload,
        payloadHash: hash,
        expiresAt,
        nonce,
      });
      memory.updateTask(taskId, { approval_id: approvalId });

      return reply.code(200).send({
        requiresApproval: true,
        approvalId,
        payloadHash: hash,
        nonce,
        prompt: `Destructive or service-altering operation (${workload}) requested.`,
      });
    }

    let finalTaskId = 0;
    if (body.approvalId) {
      const approval = memory.getApproval(body.approvalId);
      if (!approval || !approvalMatchesRequest(approval, body.prompt, body.operation)) {
        return reply.code(400).send({ error: "Approval payload does not match the stored operation" });
      }
      const claimed = memory.claimApproval(body.approvalId);
      if (!claimed) {
        return reply
          .code(400)
          .send({ error: "Approval invalid, expired or already claimed" });
      }
      const appr = memory.getApproval(body.approvalId)!;
      finalTaskId = appr.task_id;
      transitionTask(finalTaskId, "running");
    } else {
      finalTaskId = memory.addTask({
        source: "mac",
        prompt: body.prompt,
        provider: body.provider ?? null,
        status: "pending",
      });
      transitionTask(finalTaskId, "running", { workload });
    }

    try {
      const result = await routePrompt(config, body.prompt, body.provider, {
        memory,
        userId: "owner",
        projectId: config.DATA_DIR,
        approved: true,
        taskId: finalTaskId,
        workload,
        operation: body.operation,
      });
      if (memory.getTaskStatus(finalTaskId) === "cancelled") {
        throw new Error("Task was cancelled before completion");
      }
      const completion = transitionTask(finalTaskId, "done", {
        response: result.output,
        provider: result.provider,
      });
      if (!completion.applied) throw new Error(`Task completion discarded: ${completion.reason}`);
      if (body.approvalId) {
        memory.setApprovalStatus(body.approvalId, "consumed");
      }
      const item = memory.addMemory({
        source: "mac",
        title: redactConversationSecrets(body.prompt).slice(0, 80),
        content: conversationMemoryContent({ prompt: body.prompt, response: result.output, provider: result.provider }),
        provider: result.provider,
        memoryType: "conversation",
      });
      return {
        taskId: finalTaskId,
        provider: result.provider,
        output: result.output,
        requestedModel: result.requestedModel,
        returnedModel: result.returnedModel,
        usage: result.usage,
        verification: result.verification,
        memory: item,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (body.approvalId) {
        memory.setApprovalStatus(body.approvalId, "consumed");
      }
      if (memory.getTaskStatus(finalTaskId) !== "cancelled") {
        transitionTask(finalTaskId, err?.sandboxTimedOut ? "timed_out" : "failed", {
          error: message,
        });
      }
      return { taskId: finalTaskId, error: message };
    }
  });

  app.get("/api/tasks", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 20);
    return { items: memory.listTasks(limit) };
  });

  app.post("/api/tasks/:id/cancel", { preHandler: requireAuth }, async (request, reply) => {
    const taskId = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      return reply.code(400).send({ error: "invalid_task_id" });
    }
    const cancellation = transitionTask(taskId, "cancelled", { cancellation_state: "cancelled" });
    if (!cancellation.applied && cancellation.reason !== "duplicate_event") {
      return reply.code(409).send({ error: cancellation.reason, taskId, state: cancellation.status });
    }
    const approval = memory.getApprovalByTask(taskId);
    if (approval && approval.status === "claimed") {
      memory.setApprovalStatus(approval.id, "consumed");
    }
    const executorUrl = config.PERSKOP_EXECUTOR_URL || "http://sandbox-executor:18788";
    try {
      const response = await fetch(`${executorUrl}/cancel/${taskId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.PERSKOP_EXECUTOR_TOKEN}` },
      });
      if (!response.ok) throw new Error(`executor cancellation returned ${response.status}`);
      return { ok: true, taskId, state: "cancelled", executor: await response.json() };
    } catch (error) {
      return reply.code(502).send({ error: String(error), taskId, state: "cancelled" });
    }
  });

  app.post("/api/mail/sync", { preHandler: requireAuth }, async (request, reply) => {
    const result = await runEmailSync(config, memory);
    if (!result.success) {
      return reply.code(500).send({ error: result.error });
    }
    return { success: true, count: result.count };
  });

  // --- Cron job API ---

  const cronBodySchema = z.object({
    name: z.string().min(1),
    cron_expr: z.string().min(1),
    job_type: z.string().min(1),
    enabled: z.boolean().optional(),
  });

  const cronPatchSchema = z.object({
    name: z.string().min(1).optional(),
    cron_expr: z.string().min(1).optional(),
    job_type: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  });

  app.get("/api/cron", { preHandler: requireAuth }, async () => {
    return { items: memory.listCronJobs() };
  });

  app.post("/api/cron", { preHandler: requireAuth }, async (request) => {
    const body = cronBodySchema.parse(request.body);
    const id = memory.addCronJob(body);
    return { ok: true, id };
  });

  app.patch("/api/cron/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = cronPatchSchema.parse(request.body);
    memory.updateCronJob(Number(id), body);
    return { ok: true, id: Number(id) };
  });

  app.delete("/api/cron/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    memory.deleteCronJob(Number(id));
    return { ok: true };
  });

  app.post("/api/cron/:id/run", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = memory.getCronJob(Number(id));
    if (!job) {
      return reply.code(404).send({ error: "cron_job_not_found" });
    }

    request.body = request.body || {};
    const { trigger } = (request.body as Record<string, unknown>) ?? {};
    const force = trigger === "true" || trigger === "1" || trigger === true;

    return { ok: true, id: Number(id), name: job.name, queued: force };
  });

  app.get("/api/approvals", { preHandler: requireAuth }, async () => {
    return { approvals: memory.listPendingApprovals() };
  });

  app.post("/api/approvals/:id/approve", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const approval = memory.getApproval(id);
    if (!approval) return reply.code(404).send({ error: "Approval not found" });
    // Only pending approvals can be approved; re-approving a consumed one would allow replay.
    if (approval.status !== "pending") return reply.code(409).send({ error: `Approval is ${approval.status}` });
    memory.setApprovalStatus(id, "approved", "admin");
    if (approval.operation_type === "calendar_write") {
      memory.db.prepare("UPDATE calendar_operations SET status='approved' WHERE payload_hash=? AND status='pending'").run(approval.payload_hash);
    }
    return { ok: true, id };
  });

  app.post("/api/approvals/:id/reject", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const appr = memory.getApproval(id);
    if (appr) {
      memory.setApprovalStatus(id, "consumed");
      if (appr.operation_type === "calendar_write") {
        memory.db.prepare("UPDATE calendar_operations SET status='rejected',completed_at=datetime('now') WHERE payload_hash=? AND status IN ('pending','approved')").run(appr.payload_hash);
      }
      transitionTask(appr.task_id, "rejected", {
        error: "Approval rejected by user",
      });
    }
    return { ok: true, id };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const auth = request.headers["authorization"];
    const token = auth?.replace("Bearer ", "") || "";

    // P2: Use DB-backed token validation — never read from in-memory map.
    // Executor identity is the internal network address used by the sandbox.
    const executorIdentity = "sandbox-executor";
    const requestedTaskHeader = request.headers["x-perskop-task-id"];
    const requestedTaskId = requestedTaskHeader ? Number(requestedTaskHeader) : undefined;
    if (requestedTaskId !== undefined && !Number.isSafeInteger(requestedTaskId)) {
      return reply.code(400).send({ error: "Invalid task identity" });
    }
    const scope = memory.consumeScopedToken(token, executorIdentity, {
      taskId: requestedTaskId,
      scope: "model_proxy",
    });
    if (!scope) {
      return reply.code(401).send({ error: "Unauthorized or expired scoped token" });
    }

    const proxyUrl = config.PERSKOP_LLM_PROXY_URL;
    const proxySecret = config.PERSKOP_LLM_PROXY_SECRET;
    if (!proxyUrl || !proxySecret) {
      return reply.code(503).send({ error: "Model proxy is not configured" });
    }

    const body = request.body as any;

    const res = await fetch(`${proxyUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxySecret}`,
      },
      body: JSON.stringify(body),
    });

    reply.status(res.status);
    for (const [key, val] of res.headers.entries()) {
      if (key !== "content-encoding") {
        reply.header(key, val);
      }
    }

    if (res.body) {
      return Readable.fromWeb(res.body as any);
    }
    return res.text();
  });
}
