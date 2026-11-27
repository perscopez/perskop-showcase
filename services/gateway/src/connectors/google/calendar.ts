export type GoogleCalendarListItem = { id: string; summary?: string; backgroundColor?: string; accessRole?: string; etag?: string };
export type GoogleEvent = { id: string; etag?: string; status?: string; summary?: string; description?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string }; recurrence?: string[] };

export class GoogleCalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

type GoogleErrorBody = { error?: { message?: string; status?: string; errors?: Array<{ reason?: string; message?: string }> } };

function googleErrorReason(body: GoogleErrorBody | null) {
  return body?.error?.errors?.find((item) => item.reason)?.reason ?? body?.error?.status;
}

function googleErrorMessage(body: GoogleErrorBody | null) {
  return body?.error?.message ?? body?.error?.errors?.find((item) => item.message)?.message;
}

async function readGoogleError(response: Response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as GoogleErrorBody;
  } catch {
    return null;
  }
}

async function throwGoogleError(response: Response, fallback: string) {
  const body = await readGoogleError(response);
  const reason = googleErrorReason(body);
  const providerMessage = googleErrorMessage(body);
  throw new GoogleCalendarApiError(
    `${fallback} (${response.status}${reason ? ` ${reason}` : ""})`,
    response.status,
    reason,
    providerMessage,
  );
}

export class GoogleCalendarClient {
  constructor(private readonly input: { accessToken: string; fetch?: typeof fetch }) {}

  async listCalendars() {
    const items: GoogleCalendarListItem[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.request(url);
      items.push(...(body.items ?? [])); pageToken = body.nextPageToken;
    } while (pageToken);
    return items;
  }

  async listEvents(input: { calendarId: string; start?: Date; end?: Date; syncToken?: string }) {
    const items: GoogleEvent[] = []; let pageToken: string | undefined; let nextSyncToken: string | undefined;
    do {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`);
      url.searchParams.set("singleEvents", "true"); url.searchParams.set("showDeleted", "true");
      if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
      else { if (input.start) url.searchParams.set("timeMin", input.start.toISOString()); if (input.end) url.searchParams.set("timeMax", input.end.toISOString()); url.searchParams.set("orderBy", "startTime"); }
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.request(url);
      items.push(...(body.items ?? [])); pageToken = body.nextPageToken; nextSyncToken = body.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  async createEvent(input: { calendarId: string; event: Record<string, unknown> }) {
    return this.write(new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`), "POST", input.event);
  }

  async updateEvent(input: { calendarId: string; eventId: string; event: Record<string, unknown>; sourceVersion?: string | null }) {
    return this.write(new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`), "PUT", input.event, input.sourceVersion);
  }

  async deleteEvent(input: { calendarId: string; eventId: string; sourceVersion?: string | null }) {
    await this.write(new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`), "DELETE", undefined, input.sourceVersion);
  }

  private async write(url: URL, method: "POST" | "PUT" | "DELETE", body?: Record<string, unknown>, sourceVersion?: string | null) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.input.accessToken}`, Accept: "application/json" };
    if (body) { headers["Content-Type"] = "application/json"; }
    if (sourceVersion) headers["If-Match"] = sourceVersion;
    const response = await (this.input.fetch ?? fetch)(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401 || response.status === 403) await throwGoogleError(response, "Google Calendar authorization failed");
    if (response.status === 404) await throwGoogleError(response, "Google Calendar event was not found");
    if (response.status === 409 || response.status === 412) await throwGoogleError(response, "Google Calendar source version conflict");
    if (!response.ok) await throwGoogleError(response, "Google Calendar write failed");
    return response.status === 204 ? null : response.json();
  }

  private async request(url: URL) {
    const response = await (this.input.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${this.input.accessToken}`, Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) await throwGoogleError(response, "Google Calendar authorization failed");
    if (response.status === 410) await throwGoogleError(response, "Google Calendar sync token expired");
    if (!response.ok) await throwGoogleError(response, "Google Calendar request failed");
    return response.json() as Promise<any>;
  }
}

import { normalizedCalendarEventId, normalizedCalendarId } from "../calendar/normalization.js";
import type { CalendarRegistry } from "../registry.js";

function normalizeGoogleDate(input: { dateTime?: string; date?: string; timeZone?: string }) {
  const allDay = Boolean(input.date && !input.dateTime);
  const value = input.dateTime ?? `${input.date}T00:00:00.000Z`;
  return { value: new Date(value).toISOString(), allDay, timezone: input.timeZone ?? "UTC" };
}

export async function syncGoogleAccount(input: { registry: CalendarRegistry; client: GoogleCalendarClient; accountId: string; ownerId: string; displayName: string; start?: Date; end?: Date }) {
  input.registry.upsertAccount({ id: input.accountId, ownerId: input.ownerId, source: "google", displayName: input.displayName, status: "connected" });
  const calendars = await input.client.listCalendars(); let eventCount = 0;
  const start = input.start ?? new Date(Date.now() - 183 * 86400000); const end = input.end ?? new Date(Date.now() + 366 * 86400000);
  for (const calendar of calendars) {
    const calendarId = normalizedCalendarId({ source: "google", accountId: input.accountId, sourceCalendarId: calendar.id });
    const writable = calendar.accessRole === "owner" || calendar.accessRole === "writer";
    input.registry.upsertCalendar({ id: calendarId, accountId: input.accountId, sourceCalendarId: calendar.id, name: calendar.summary ?? "Adsız Takvim", color: calendar.backgroundColor ?? null, capabilities: { read: true, create: writable, update: writable, delete: writable }, freshness: "fresh", sourceVersion: calendar.etag ?? null });
    const result = await input.client.listEvents({ calendarId: calendar.id, start, end });
    for (const event of result.items) {
      if (!event.id || event.status === "cancelled" || !event.start || !event.end) continue;
      const eventStart = normalizeGoogleDate(event.start); const eventEnd = normalizeGoogleDate(event.end);
      input.registry.upsertEvent({ id: normalizedCalendarEventId({ source: "google", accountId: input.accountId, calendarId: calendar.id, sourceEventId: event.id }), calendarId, sourceEventId: event.id, sourceVersion: event.etag ?? null, eventJson: { sourceEventId: event.id, title: event.summary ?? "Adsız Etkinlik", notes: event.description ?? null, location: event.location ?? null, url: event.htmlLink ?? null, startAt: eventStart.value, endAt: eventEnd.value, timezone: eventStart.timezone, allDay: eventStart.allDay, recurrenceRule: event.recurrence?.join("\n") ?? null }, startsAt: eventStart.value, endsAt: eventEnd.value, freshness: "fresh" });
      eventCount += 1;
    }
  }
  return { status: "synced" as const, calendarCount: calendars.length, eventCount };
}
