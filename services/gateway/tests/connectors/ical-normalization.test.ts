import test from "node:test";
import assert from "node:assert/strict";
import { parseIcalendarEvents } from "../../src/connectors/calendar/ical.js";

test("normalizes timed and all-day VEVENT values", () => {
  const events = parseIcalendarEvents(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:lesson-1\r\nSUMMARY:Almanca\\, Ders\r\nDESCRIPTION:Satır 1\\nSatır 2\r\nDTSTART:20260715T110000Z\r\nDTEND:20260715T120000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:birthday-1\r\nSUMMARY:Doğum Günü\r\nDTSTART;VALUE=DATE:20260720\r\nDTEND;VALUE=DATE:20260721\r\nEND:VEVENT\r\nEND:VCALENDAR`);
  assert.deepEqual(events[0], {
    sourceEventId: "lesson-1", title: "Almanca, Ders", notes: "Satır 1\nSatır 2",
    location: null, url: null, startAt: "2026-07-15T11:00:00.000Z", endAt: "2026-07-15T12:00:00.000Z",
    timezone: "UTC", allDay: false, recurrenceRule: null,
  });
  assert.equal(events[1]?.allDay, true);
  assert.equal(events[1]?.startAt, "2026-07-20T00:00:00.000Z");
});

test("unfolds lines and rejects incomplete events", () => {
  const events = parseIcalendarEvents(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:folded\nSUMMARY:Uzun başlık \n devam ediyor\nDTSTART:20260715T110000Z\nDTEND:20260715T120000Z\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Eksik UID\nEND:VEVENT\nEND:VCALENDAR`);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "Uzun başlık devam ediyor");
});
