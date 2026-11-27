export type ParsedCalendarEvent = {
  sourceEventId: string;
  title: string;
  notes: string | null;
  location: string | null;
  url: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  allDay: boolean;
  recurrenceRule: string | null;
};

function unescapeText(value: string) {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseDate(value: string, allDay: boolean) {
  if (allDay) return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`).toISOString();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) throw new Error("unsupported iCalendar date");
  const [, year, month, day, hour, minute, second, zulu] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zulu ? "Z" : "Z"}`).toISOString();
}

export function parseIcalendarEvents(source: string): ParsedCalendarEvent[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const results: ParsedCalendarEvent[] = [];
  let fields: Map<string, { params: string; value: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { fields = new Map(); continue; }
    if (line === "END:VEVENT") {
      if (fields) {
        const uid = fields.get("UID")?.value;
        const start = fields.get("DTSTART");
        const end = fields.get("DTEND");
        if (uid && start && end) {
          const allDay = /VALUE=DATE/i.test(start.params);
          const timezone = start.params.match(/TZID=([^;:]+)/i)?.[1] ?? "UTC";
          try {
            results.push({ sourceEventId: uid, title: unescapeText(fields.get("SUMMARY")?.value ?? "Adsız Etkinlik"), notes: fields.get("DESCRIPTION") ? unescapeText(fields.get("DESCRIPTION")!.value) : null, location: fields.get("LOCATION") ? unescapeText(fields.get("LOCATION")!.value) : null, url: fields.get("URL")?.value ?? null, startAt: parseDate(start.value, allDay), endAt: parseDate(end.value, allDay), timezone, allDay, recurrenceRule: fields.get("RRULE")?.value ?? null });
          } catch { /* Ignore malformed source objects without poisoning the whole sync. */ }
        }
      }
      fields = null; continue;
    }
    if (!fields) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const left = line.slice(0, colon);
    const [name = "", ...params] = left.split(";");
    fields.set(name.toUpperCase(), { params: params.join(";"), value: line.slice(colon + 1) });
  }
  return results;
}
