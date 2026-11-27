import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { MemoryStore } from "../db.js";
import { RemoteSessionStore } from "../remote/sessionStore.js";
import {
  deleteRemotePromptPayload,
  getRemotePromptPayload,
  publishRemoteCommandResult,
  putRemotePromptPayload,
} from "../remote/commandBroker.js";

const sessionSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(300).nullable().default(null),
  preview: z.string().max(500).nullable().default(null),
  cwd: z.string().max(1000).nullable().default(null),
  profile: z.string().max(100).nullable().default(null),
  isActive: z.boolean().default(false),
  lastActive: z.number().finite().nonnegative().default(0),
});

const heartbeatSchema = z.object({
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  displayName: z.string().min(1).max(100),
  appVersion: z.string().max(50).nullable().optional(),
  sessions: z.array(sessionSchema).max(50),
});

const commandSchema = z.object({
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  action: z.enum(["focus_session", "new_session", "read_session", "send_prompt"]),
  sessionId: z.string().min(1).max(200).nullable().optional(),
  prompt: z.string().min(1).max(12_000).optional(),
}).superRefine((value, ctx) => {
  if ((value.action === "focus_session" || value.action === "read_session" || value.action === "send_prompt") && !value.sessionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "sessionId required" });
  }
  if (value.action === "send_prompt" && !value.prompt?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompt"], message: "prompt required" });
  }
});

export function registerRemoteRoutes(
  app: FastifyInstance,
  requireAuth: preHandlerHookHandler,
  memory: MemoryStore,
) {
  const remote = new RemoteSessionStore(memory.db);

  app.post("/api/remote/heartbeat", { preHandler: requireAuth }, async (request) => {
    const body = heartbeatSchema.parse(request.body);
    remote.heartbeat(body);
    return { ok: true };
  });

  app.get("/api/remote/nodes", { preHandler: requireAuth }, async () => ({ items: remote.listNodes() }));

  app.get("/api/remote/sessions", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ nodeId: z.string().optional() }).parse(request.query);
    return { items: remote.listSessions(query.nodeId) };
  });

  app.post("/api/remote/commands", { preHandler: requireAuth }, async (request) => {
    const body = commandSchema.parse(request.body);
    const item = remote.queueCommand(body);
    if (body.action === "send_prompt") putRemotePromptPayload(String(item.id), body.prompt!.trim());
    return { item };
  });

  app.get("/api/remote/nodes/:nodeId/commands", { preHandler: requireAuth }, async (request) => {
    const { nodeId } = z.object({ nodeId: z.string() }).parse(request.params);
    const items = remote.listPendingCommands(nodeId).map((item) => item.action === "send_prompt"
      ? { ...item, payload: { prompt: getRemotePromptPayload(String(item.id)) } }
      : item);
    return { items };
  });

  app.post("/api/remote/nodes/:nodeId/commands/:commandId/complete", { preHandler: requireAuth }, async (request, reply) => {
    const { nodeId, commandId } = z.object({ nodeId: z.string(), commandId: z.string().uuid() }).parse(request.params);
    const body = z.object({ ok: z.boolean(), result: z.string().max(100_000).nullable().optional(), error: z.string().max(1000).nullable().optional() }).parse(request.body);
    if (!remote.completeCommand(commandId, nodeId, body.ok, body.error)) {
      return reply.code(409).send({ error: "command_not_pending" });
    }
    deleteRemotePromptPayload(commandId);
    publishRemoteCommandResult(commandId, body);
    return { ok: true };
  });
}
