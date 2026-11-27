import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { MemoryStore } from "../db.js";
import { NodeService, type NodeCapability } from "../tasks/nodeService.js";
import { TaskService } from "../tasks/taskService.js";

const capabilitySchema = z.enum(["session_control", "repository_write", "chat"]);

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

export function registerNodeRoutes(
  app: FastifyInstance,
  requireAuth: preHandlerHookHandler,
  memory: MemoryStore,
) {
  const nodes = new NodeService(memory);
  const tasks = new TaskService(memory);

  const requireNode = async (request: any, reply: any) => {
    const nodeId = String((request.params as { nodeId?: string }).nodeId ?? request.headers["x-perskop-node-id"] ?? "");
    const token = extractBearer(request.headers.authorization);
    if (!nodeId || !token) return reply.code(401).send({ error: "node_unauthorized" });
    try {
      nodes.authenticate(nodeId, token);
    } catch (error) {
      const code = error instanceof Error && error.message === "node_revoked" ? 401 : 401;
      return reply.code(code).send({ error: error instanceof Error ? error.message : "node_unauthorized" });
    }
    request.perskopNodeId = nodeId;
    request.perskopNodeToken = token;
  };

  app.post("/api/nodes/register", { preHandler: requireAuth }, async (request) => {
    const body = z.object({
      nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      displayName: z.string().min(1).max(100),
      appVersion: z.string().max(50).nullable().optional(),
      capabilities: z.array(capabilitySchema).max(20).default(["session_control"]),
    }).parse(request.body);
    const registered = nodes.register({
      nodeId: body.nodeId,
      displayName: body.displayName,
      appVersion: body.appVersion,
      capabilities: body.capabilities as NodeCapability[],
    });
    return { ok: true, ...registered };
  });

  app.get("/api/nodes", { preHandler: requireAuth }, async () => ({
    items: nodes.listNodes().map((node) => ({
      id: node.id,
      displayName: node.display_name,
      appVersion: node.app_version,
      capabilities: JSON.parse(String(node.capabilities_json || "[]")),
      online: Boolean(node.online),
      currentLoad: node.current_load,
      sessionCount: node.session_count,
      lastHeartbeatAt: node.last_heartbeat_at,
      onlineLeaseUntil: node.online_lease_until,
      revokedAt: node.revoked_at,
    })),
  }));

  app.post("/api/nodes/:nodeId/revoke", { preHandler: requireAuth }, async (request) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    nodes.revoke(nodeId);
    return { ok: true, nodeId, revoked: true };
  });

  app.post("/api/nodes/:nodeId/heartbeat", { preHandler: requireNode }, async (request) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    const body = z.object({
      capabilities: z.array(capabilitySchema).max(20).default([]),
      currentLoad: z.number().int().min(0).max(100).default(0),
      sessions: z.array(z.object({
        sessionId: z.string().min(1).max(200),
        source: z.string().max(50).optional(),
        provider: z.string().max(50).nullable().optional(),
        status: z.string().max(50).optional(),
        title: z.string().max(300).nullable().optional(),
      })).max(50).default([]),
    }).parse(request.body ?? {});
    nodes.heartbeat({
      nodeId,
      token: (request as any).perskopNodeToken,
      capabilities: body.capabilities as NodeCapability[],
      currentLoad: body.currentLoad,
      sessions: body.sessions.map((session) => ({
        sessionId: session.sessionId,
        source: session.source,
        provider: session.provider,
        status: session.status,
        title: session.title,
      })),
    });
    return {
      ok: true,
      nodeId,
      claimable: nodes.listClaimableTasks(nodeId).length,
    };
  });

  app.get("/api/nodes/:nodeId/tasks", { preHandler: requireNode }, async (request) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    return { items: nodes.listClaimableTasks(nodeId) };
  });

  app.post("/api/nodes/:nodeId/tasks/:taskId/claim", { preHandler: requireNode }, async (request, reply) => {
    const params = z.object({ nodeId: z.string(), taskId: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ expectedRevision: z.number().int().positive() }).parse(request.body ?? {});
    const result = nodes.claimTask({
      nodeId: params.nodeId,
      token: (request as any).perskopNodeToken,
      taskId: params.taskId,
      expectedRevision: body.expectedRevision,
    });
    if (!result.ok) return reply.code(409).send({ error: result.reason, status: result.status, revision: result.revision });
    return { ok: true, taskId: params.taskId, status: result.status, revision: result.revision };
  });

  app.post("/api/nodes/:nodeId/tasks/:taskId/progress", { preHandler: requireNode }, async (request, reply) => {
    const params = z.object({ nodeId: z.string(), taskId: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({
      expectedRevision: z.number().int().positive(),
      message: z.string().max(500).optional(),
      percent: z.number().min(0).max(100).optional(),
    }).parse(request.body ?? {});
    try {
      nodes.authenticate(params.nodeId, (request as any).perskopNodeToken);
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "node_unauthorized" });
    }
    const current = memory.db.prepare("SELECT status,revision,target_node_id FROM tasks WHERE id=?").get(params.taskId) as
      | { status: string; revision: number; target_node_id: string | null }
      | undefined;
    if (!current) return reply.code(404).send({ error: "task_not_found" });
    if (current.target_node_id && current.target_node_id !== params.nodeId) {
      return reply.code(409).send({ error: "task_not_assigned_to_node" });
    }
    if (current.revision !== body.expectedRevision) {
      return reply.code(409).send({ error: "revision_conflict", revision: current.revision, status: current.status });
    }
    if (current.status !== "running") {
      return reply.code(409).send({ error: "task_not_running", status: current.status, revision: current.revision });
    }
    nodes.appendTaskEvent({
      taskId: params.taskId,
      nodeId: params.nodeId,
      eventType: "progress",
      revision: current.revision,
      payload: { message: body.message, percent: body.percent },
    });
    return { ok: true, taskId: params.taskId, revision: current.revision };
  });

  app.post("/api/nodes/:nodeId/tasks/:taskId/complete", { preHandler: requireNode }, async (request, reply) => {
    const params = z.object({ nodeId: z.string(), taskId: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({
      expectedRevision: z.number().int().positive(),
      response: z.string().max(100_000),
      provider: z.string().max(100),
    }).parse(request.body ?? {});
    const current = memory.db.prepare("SELECT status,revision,target_node_id FROM tasks WHERE id=?").get(params.taskId) as
      | { status: string; revision: number; target_node_id: string | null }
      | undefined;
    if (!current) return reply.code(404).send({ error: "task_not_found" });
    if (current.target_node_id && current.target_node_id !== params.nodeId) {
      return reply.code(409).send({ error: "task_not_assigned_to_node" });
    }
    const transition = tasks.transition(params.taskId, {
      to: "succeeded",
      expectedRevision: body.expectedRevision,
      fields: { response: body.response, provider: body.provider },
    });
    if (!transition.applied) {
      return reply.code(409).send({ error: transition.reason, status: transition.status, revision: transition.revision });
    }
    nodes.appendTaskEvent({
      taskId: params.taskId,
      nodeId: params.nodeId,
      eventType: "completed",
      revision: transition.revision,
    });
    memory.db.prepare(`
      UPDATE nodes SET current_load = MAX(current_load - 1, 0), updated_at = datetime('now') WHERE id = ?
    `).run(params.nodeId);
    return { ok: true, taskId: params.taskId, status: transition.status, revision: transition.revision };
  });
}
