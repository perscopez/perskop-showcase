import type { CalendarRegistry } from "../registry.js";
import { normalizedCalendarEventId, normalizedCalendarId } from "../calendar/normalization.js";
import { parseIcalendarEvents } from "../calendar/ical.js";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const CALSERVER = "http://calendarserver.org/ns/";

function href(xml: string, property: string): string {
  const block = xml.match(new RegExp(`<[^>]*${property}[^>]*>([\\s\\S]*?)<\\/[^>]*${property}>`, "i"))?.[1] ?? "";
  const value = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)?.[1];
  if (!value) throw new Error(`iCloud CalDAV response is missing ${property}`);
  return value;
}

function absolute(base: string, value: string) {
  return new URL(value, base).toString();
}

function caldavUtc(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export class IcloudCaldavClient {
  constructor(private readonly input: { username: string; appSpecificPassword: string; fetch?: typeof fetch }) {}

  async discover() {
    const origin = "https://caldav.icloud.com/";
    const principalXml = await this.propfind(origin, `<d:propfind xmlns:d="${DAV}"><d:prop><d:current-user-principal/></d:prop></d:propfind>`, "0");
    const principalUrl = absolute(origin, href(principalXml, "current-user-principal"));
    const homeXml = await this.propfind(principalUrl, `<d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, "0");
    const calendarHomeUrl = absolute(origin, href(homeXml, "calendar-home-set"));
    const calendarsXml = await this.propfind(calendarHomeUrl, `<d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}" xmlns:cs="${CALSERVER}"><d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><cs:getctag/></d:prop></d:propfind>`, "1");
    const calendars = [...calendarsXml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi)].flatMap((match) => {
      const block = match[1] ?? "";
      if (!/<[^>]*\bcalendar\b[^>]*>/i.test(block)) return [];
      const itemHref = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)?.[1];
      if (!itemHref) return [];
      const name = block.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i)?.[1] ?? "Adsız Takvim";
      const sourceVersion = block.match(/<[^>]*getctag[^>]*>([^<]*)<\/[^>]*getctag>/i)?.[1] ?? null;
      return [{ url: absolute(origin, itemHref), name, writable: /<[^>]*write\s*\/?\s*>/i.test(block), sourceVersion }];
    });
    return { principalUrl, calendarHomeUrl, calendars };
  }

  async queryEvents(calendarUrl: string, start: Date, end: Date) {
    const body = `<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${caldavUtc(start)}" end="${caldavUtc(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const xml = await this.request(calendarUrl, { method: "REPORT", depth: "1", body });
    return [...xml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi)].flatMap((match) => {
      const block = match[1] ?? "";
      const itemHref = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)?.[1];
      const data = block.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/i)?.[1];
      if (!itemHref || !data) return [];
      return [{ url: absolute(calendarUrl, itemHref), etag: block.match(/<[^>]*getetag[^>]*>([^<]+)<\/[^>]*getetag>/i)?.[1] ?? null, data }];
    });
  }

  async putEvent(url: string, data: string, sourceVersion?: string) {
    return this.write(url, "PUT", sourceVersion, data);
  }

  async deleteEvent(url: string, sourceVersion: string) {
    await this.write(url, "DELETE", sourceVersion);
  }

  private async write(url: string, method: "PUT" | "DELETE", sourceVersion?: string, body?: string) {
    const headers: Record<string, string> = { Authorization: this.authorization() };
    if (body) headers["Content-Type"] = "text/calendar; charset=utf-8";
    if (sourceVersion) headers["If-Match"] = sourceVersion; else if (method === "PUT") headers["If-None-Match"] = "*";
    const response = await (this.input.fetch ?? fetch)(url, { method, headers, body });
    if (response.status === 409 || response.status === 412) throw new Error("iCloud CalDAV source version conflict");
    if (!response.ok) throw new Error(`iCloud CalDAV write failed (${response.status})`);
    return { sourceVersion: response.headers.get("etag") };
  }

  private async propfind(url: string, body: string, depth: "0" | "1") {
    return this.request(url, { method: "PROPFIND", depth, body });
  }

  private authorization() {
    return `Basic ${Buffer.from(`${this.input.username}:${this.input.appSpecificPassword}`).toString("base64")}`;
  }

  private async request(url: string, input: { method: "PROPFIND" | "REPORT"; depth: "0" | "1"; body: string }) {
    const response = await (this.input.fetch ?? fetch)(url, { method: input.method, headers: { Authorization: this.authorization(), Depth: input.depth, "Content-Type": "application/xml; charset=utf-8" }, body: input.body });
    if (response.status === 401 || response.status === 403) throw new Error("iCloud CalDAV authentication failed");
    if (!response.ok && response.status !== 207) throw new Error(`iCloud CalDAV discovery failed (${response.status})`);
    return response.text();
  }
}

export async function syncIcloudAccount(input: {
  registry: CalendarRegistry;
  client: IcloudCaldavClient;
  accountId: string;
  ownerId: string;
  displayName: string;
  start?: Date;
  end?: Date;
}) {
  const start = input.start ?? new Date(Date.now() - 183 * 24 * 60 * 60 * 1000);
  const end = input.end ?? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
  const discovered = await input.client.discover();
  input.registry.upsertAccount({ id: input.accountId, ownerId: input.ownerId, source: "icloud", displayName: input.displayName, status: "connected" });
  let eventCount = 0;
  for (const calendar of discovered.calendars) {
    const calendarId = normalizedCalendarId({ source: "icloud", accountId: input.accountId, sourceCalendarId: calendar.url });
    input.registry.upsertCalendar({ id: calendarId, accountId: input.accountId, sourceCalendarId: calendar.url, name: calendar.name, color: null, capabilities: { read: true, create: calendar.writable, update: calendar.writable, delete: calendar.writable }, freshness: "fresh", sourceVersion: calendar.sourceVersion });
    const objects = await input.client.queryEvents(calendar.url, start, end);
    for (const object of objects) {
      for (const event of parseIcalendarEvents(object.data)) {
        input.registry.upsertEvent({ id: normalizedCalendarEventId({ source: "icloud", accountId: input.accountId, calendarId: calendar.url, sourceEventId: event.sourceEventId }), calendarId, sourceEventId: event.sourceEventId, sourceVersion: object.etag, eventJson: { ...event, sourceUrl: object.url }, startsAt: event.startAt, endsAt: event.endAt, freshness: "fresh" });
        eventCount += 1;
      }
    }
  }
  return { status: "synced" as const, calendarCount: discovered.calendars.length, eventCount, start: start.toISOString(), end: end.toISOString() };
}
