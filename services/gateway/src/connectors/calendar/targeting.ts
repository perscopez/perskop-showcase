import type { UnifiedCalendar } from "../types.js";

export type CalendarIntent = "ders" | "sınav" | "aile" | "diğer";

export function selectCalendarTarget(input: {
  intent: CalendarIntent;
  calendars: UnifiedCalendar[];
  lastUsedCalendarId?: string | null;
}): { calendar: UnifiedCalendar | null; reason?: "ambiguous" | "selection_required" } {
  const writable = input.calendars.filter((calendar) => calendar.capabilities.create);
  const configuredName: Partial<Record<CalendarIntent, string>> = {
    ders: "derslerim",
    sınav: "sınavlarım",
    aile: "aile",
  };
  const name = configuredName[input.intent];
  if (name) {
    const candidates = writable.filter((calendar) => calendar.name.trim().toLocaleLowerCase("tr-TR") === name);
    if (candidates.length === 1) return { calendar: candidates[0]! };
    if (candidates.length > 1) return { calendar: null, reason: "ambiguous" };
  }
  const lastUsed = input.lastUsedCalendarId ? writable.find((calendar) => calendar.id === input.lastUsedCalendarId) : undefined;
  return lastUsed ? { calendar: lastUsed } : { calendar: null, reason: "selection_required" };
}
