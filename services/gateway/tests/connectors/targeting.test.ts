import test from "node:test";
import assert from "node:assert/strict";
import { selectCalendarTarget } from "../../src/connectors/calendar/targeting.js";
import type { UnifiedCalendar } from "../../src/connectors/types.js";

const base = (id: string, name: string, writable = true): UnifiedCalendar => ({
  id, name, source: "icloud", accountId: "owner", calendarId: id, color: null,
  capabilities: { read: true, create: writable, update: writable, delete: writable },
  freshness: "fresh", sourceVersion: null,
});
const calendars = [base("lessons", "Derslerim"), base("exams", "Sınavlarım"), base("family", "Aile"), base("readonly", "Tatiller", false), base("default", "Calendar")];

test("calendar targeting routes explicit Turkish categories and uses last writable calendar", () => {
  assert.equal(selectCalendarTarget({ intent: "ders", calendars }).calendar?.id, "lessons");
  assert.equal(selectCalendarTarget({ intent: "sınav", calendars }).calendar?.id, "exams");
  assert.equal(selectCalendarTarget({ intent: "aile", calendars }).calendar?.id, "family");
  assert.equal(selectCalendarTarget({ intent: "diğer", calendars, lastUsedCalendarId: "default" }).calendar?.id, "default");
});

test("calendar targeting never guesses when no writable default exists or target is ambiguous", () => {
  assert.equal(selectCalendarTarget({ intent: "ders", calendars: [base("a", "Derslerim"), base("b", "Derslerim")] }).reason, "ambiguous");
  assert.equal(selectCalendarTarget({ intent: "diğer", calendars: [base("r", "read-only", false)] }).reason, "selection_required");
});
