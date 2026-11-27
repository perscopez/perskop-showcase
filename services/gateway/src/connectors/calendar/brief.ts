import type { CalendarRegistry } from "../registry.js";

type BriefEvent = ReturnType<CalendarRegistry["listEvents"]>[number];

function dayKey(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const read = (name: string) => parts.find((part) => part.type === name)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function addDays(value: Date, days: number) { const result = new Date(value); result.setUTCDate(result.getUTCDate() + days); return result; }
function important(event: BriefEvent) { return /\b(sınav|exam|deadline|son tarih|başvuru|application|randevu|appointment|diş|teeth|doğum günü|birthday|kurs|course|ders|lesson)\b/i.test(event.title); }
function label(event: BriefEvent) { return event.source === "icloud" ? "iCloud" : event.source === "google" ? "Google" : event.source.toUpperCase(); }
function eventLine(event: BriefEvent, timeZone: string, includeDate = false) {
  const date = new Intl.DateTimeFormat("tr-TR", { timeZone, day: "2-digit", month: "short", weekday: "short" }).format(new Date(event.startAt));
  const when = event.allDay ? "Tüm gün" : new Intl.DateTimeFormat("tr-TR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(event.startAt));
  return `• ${includeDate ? `${date} · ` : ""}${when} — ${event.title} [${label(event)}]`;
}

/** Formats the user's 13:00/22:00 brief: today, tomorrow, then prioritized upcoming items. */
export function formatCalendarBrief(registry: CalendarRegistry, input: { now?: Date; timeZone?: string; horizonDays?: number } = {}) {
  const now = input.now ?? new Date(); const timeZone = input.timeZone ?? "Europe/Istanbul"; const horizonDays = input.horizonDays ?? 60;
  const today = dayKey(now, timeZone); const tomorrow = dayKey(addDays(now, 1), timeZone);
  const events = registry.listEvents("owner", now.toISOString(), addDays(now, horizonDays).toISOString());
  const groups = { today: [] as BriefEvent[], tomorrow: [] as BriefEvent[], importantUpcoming: [] as BriefEvent[], nextUpcoming: [] as BriefEvent[] };
  for (const event of events) {
    const key = dayKey(new Date(event.startAt), timeZone);
    if (key === today) groups.today.push(event);
    else if (key === tomorrow) groups.tomorrow.push(event);
    else if (important(event)) groups.importantUpcoming.push(event);
    else groups.nextUpcoming.push(event);
  }
  const sort = (items: BriefEvent[]) => items.sort((a, b) => a.startAt.localeCompare(b.startAt));
  sort(groups.today); sort(groups.tomorrow); sort(groups.importantUpcoming); sort(groups.nextUpcoming);
  const render = (title: string, items: BriefEvent[], includeDate = false) => items.length ? `${title}\n${items.map((event) => eventLine(event, timeZone, includeDate)).join("\n")}` : `${title}\n• Yok`;
  const importantItems = groups.importantUpcoming.slice(0, 6);
  const importantIds = new Set(importantItems.map((event) => event.id));
  const nextItems = groups.nextUpcoming.filter((event) => !importantIds.has(event.id)).slice(0, 5);
  return [
    "📅 Takvim özeti",
    render("Bugün", groups.today),
    render("Yarın", groups.tomorrow),
    importantItems.length ? render(`Önümüzdeki ${horizonDays} gün — önemli`, importantItems, true) : null,
    nextItems.length ? render(`Önümüzdeki ${horizonDays} gün — sıradaki`, nextItems, true) : null,
  ].filter(Boolean).join("\n\n");
}
