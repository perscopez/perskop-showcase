import crypto from "node:crypto";
import net from "node:net";
import { z } from "zod";
import type { GmailMessagePart } from "../connectors/google/gmail.js";
import type { StoredGmailThread } from "./gmailStore.js";
import { canonicalize } from "../utils/jcs.js";
import { equalApprovalHash } from "../security/repositoryApproval.js";

export interface UnsubscribeCandidate {
  id: string;
  accountId: string;
  threadId: string;
  messageId: string;
  sender: string;
  subject: string;
  oneClickUrl: string | null;
  mailtoUrl: string | null;
  executable: boolean;
}

function header(part: GmailMessagePart | undefined, name: string): string {
  return part?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return z.string().email().safeParse(decodeURIComponent(url.pathname)).success ? url : null;
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    const ip = net.isIP(host);
    if (ip === 4 && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    if (ip === 6 && (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))) return null;
    return url;
  } catch { return null; }
}

export function extractUnsubscribeCandidate(thread: StoredGmailThread): UnsubscribeCandidate | null {
  const message = thread.messages.at(-1);
  if (!message) return null;
  const payload = message.payload as GmailMessagePart;
  const list = header(payload, "List-Unsubscribe");
  if (!list) return null;
  const urls = [...list.matchAll(/<([^>]+)>/g)].map(match => safeUrl(match[1])).filter((url): url is URL => Boolean(url));
  const post = header(payload, "List-Unsubscribe-Post").toLowerCase();
  const https = urls.find(url => url.protocol === "https:");
  const mailto = urls.find(url => url.protocol === "mailto:");
  const oneClickUrl = https && post.includes("list-unsubscribe=one-click") ? https.toString() : null;
  const mailtoUrl = mailto?.toString() ?? null;
  if (!oneClickUrl && !mailtoUrl) return null;
  const identity = [thread.accountId, thread.threadId, message.messageId, oneClickUrl ?? "", mailtoUrl ?? ""].join("\0");
  return {
    id: `unsub-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    accountId: thread.accountId,
    threadId: thread.threadId,
    messageId: message.messageId,
    sender: thread.from,
    subject: thread.subject,
    oneClickUrl,
    mailtoUrl,
    executable: Boolean(oneClickUrl || mailtoUrl),
  };
}

export const unsubscribeApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  operationType: z.literal("email_unsubscribe"),
  taskId: z.number().int().positive(),
  accountId: z.string().min(1).max(200),
  candidates: z.array(z.object({
    id: z.string().min(1).max(200),
    sender: z.string().min(1).max(998),
    oneClickUrl: z.string().url().nullable(),
    mailtoUrl: z.string().url().nullable(),
  }).strict()).min(1).max(100),
  nonce: z.string().min(20).max(200),
}).strict();

export type UnsubscribeApproval = z.infer<typeof unsubscribeApprovalSchema>;

export function canonicalUnsubscribeApproval(value: UnsubscribeApproval): string {
  return canonicalize(unsubscribeApprovalSchema.parse(value));
}

export function hashUnsubscribeApproval(value: string): string {
  return crypto.createHash("sha256").update("perskop-email-unsubscribe-v1\0").update(value).digest("hex");
}

export function unsubscribeApprovalMatches(left: string, right: string): boolean {
  return equalApprovalHash(left, right);
}
