import crypto from "node:crypto";
import type { CalendarIdentity } from "../types.js";

export function normalizedCalendarId(input: Omit<CalendarIdentity, "calendarId"> & { sourceCalendarId: string }): string {
  const value = [input.source, input.accountId, input.sourceCalendarId].join("\0");
  return `calendar_${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Stable, non-reversible identity for an event in an authoritative source. */
export function normalizedCalendarEventId(input: CalendarIdentity & { sourceEventId: string }): string {
  const value = [input.source, input.accountId, input.calendarId, input.sourceEventId].join("\0");
  return `cal_${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
