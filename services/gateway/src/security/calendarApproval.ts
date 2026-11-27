import crypto from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../utils/jcs.js";

export const calendarMutationSchema = z.object({
  schemaVersion: z.literal(1).default(1), action: z.enum(["create", "update", "move", "delete"]),
  accountId: z.string().min(1), calendarId: z.string().min(1), eventId: z.string().min(1).optional(), sourceVersion: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(1024).optional(), notes: z.string().max(20000).nullable().optional(), location: z.string().max(2048).nullable().optional(), url: z.string().url().nullable().optional(), attendees: z.array(z.string().email()).max(100).optional(),
  startAt: z.string().datetime().optional(), endAt: z.string().datetime().optional(), timezone: z.string().min(1).optional(), allDay: z.boolean().optional(), recurrenceRule: z.string().max(4096).nullable().optional(), reminderMinutes: z.array(z.number().int().min(0).max(40320)).max(5).optional(), idempotencyKey: z.string().min(16).max(256),
}).strict().superRefine((input, ctx) => {
  if (input.action === "create" && (!input.title || !input.startAt || !input.endAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "create requires title, startAt and endAt" });
  if (input.action !== "create" && !input.eventId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "existing event mutations require eventId" });
});
export type CalendarMutation = z.infer<typeof calendarMutationSchema>;
export function canonicalCalendarApproval(input: { taskId: number; nonce: string; mutation: CalendarMutation }) { return canonicalize({ operationType: "calendar_write", taskId: input.taskId, nonce: input.nonce, mutation: calendarMutationSchema.parse(input.mutation) }); }
export function hashCalendarApproval(value: string) { return crypto.createHash("sha256").update("perskop-calendar-approval-v1\0").update(value).digest("hex"); }
export function equalCalendarApprovalHash(left: string, right: string) { return /^[0-9a-f]{64}$/i.test(left) && /^[0-9a-f]{64}$/i.test(right) && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
