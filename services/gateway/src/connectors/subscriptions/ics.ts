import crypto from "node:crypto";
import { parseIcalendarEvents } from "../calendar/ical.js";
import { normalizedCalendarEventId, normalizedCalendarId } from "../calendar/normalization.js";
import type { CalendarRegistry } from "../registry.js";

export async function syncIcsSubscription(input: { registry: CalendarRegistry; ownerId: string; accountId: string; name: string; url: string; fetch?: typeof fetch }) {
  const parsed = new URL(input.url);
  if (parsed.protocol !== "https:") throw new Error("ICS subscription must use HTTPS");
  const response = await (input.fetch ?? fetch)(parsed, { headers: { Accept: "text/calendar" }, redirect: "error" });
  if (!response.ok) throw new Error(`ICS subscription fetch failed (${response.status})`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 5_000_000) throw new Error("ICS subscription is too large");
  const events = parseIcalendarEvents(body);
  const sourceVersion = response.headers.get("etag") ?? crypto.createHash("sha256").update(body).digest("hex");
  input.registry.upsertAccount({ id: input.accountId, ownerId: input.ownerId, source: "ics", displayName: input.name, status: "connected" });
  const calendarId = normalizedCalendarId({ source: "ics", accountId: input.accountId, sourceCalendarId: input.url });
  input.registry.upsertCalendar({ id: calendarId, accountId: input.accountId, sourceCalendarId: input.url, name: input.name, color: null, capabilities: { read: true, create: false, update: false, delete: false }, freshness: "fresh", sourceVersion });
  for (const event of events) input.registry.upsertEvent({ id: normalizedCalendarEventId({ source: "ics", accountId: input.accountId, calendarId: input.url, sourceEventId: event.sourceEventId }), calendarId, sourceEventId: event.sourceEventId, sourceVersion, eventJson: event, startsAt: event.startAt, endsAt: event.endAt, freshness: "fresh" });
  return { status: "synced" as const, eventCount: events.length };
}
