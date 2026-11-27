import crypto from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../utils/jcs.js";
import { equalApprovalHash } from "./repositoryApproval.js";

const mailbox = z.string().email().max(320);

export const emailAttachmentApprovalSchema = z.object({
  id: z.string().min(1).max(200),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().min(0).max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const emailSendApprovalSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  operationType: z.literal("email_send").default("email_send"),
  taskId: z.number().int().positive(),
  accountId: z.string().min(1).max(200),
  draftId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200).nullable(),
  to: z.array(mailbox).min(1).max(100),
  cc: z.array(mailbox).max(100),
  bcc: z.array(mailbox).max(100),
  subject: z.string().max(998),
  bodyText: z.string().max(2_000_000),
  attachments: z.array(emailAttachmentApprovalSchema).max(50),
  nonce: z.string().min(20).max(200),
}).strict();

export type EmailSendApproval = z.infer<typeof emailSendApprovalSchema>;

export function canonicalEmailSendApproval(input: EmailSendApproval): string {
  return canonicalize(emailSendApprovalSchema.parse(input));
}

export function hashEmailSendApproval(canonicalPayload: string): string {
  return crypto.createHash("sha256")
    .update("perskop-email-send-approval-v1\0", "utf8")
    .update(canonicalPayload, "utf8")
    .digest("hex");
}

export function emailApprovalMatches(left: string, right: string): boolean {
  return equalApprovalHash(left, right);
}
