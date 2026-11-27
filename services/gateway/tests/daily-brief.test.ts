import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/db.js";
import { CalendarRegistry } from "../src/connectors/registry.js";
import { formatDailyCalendarSection, formatDailyMailSection, selectDailyMailGroups } from "../src/cron/dailyBrief.js";
import { labelDailyMailGroups } from "../src/cron/dailyBriefLabels.js";
import { loadShownDailyBriefMailUids, markDailyBriefMailsShown } from "../src/cron/dailyBriefState.js";
import { msUntilNextLocalHour } from "../src/cron/scheduler.js";
import type { InboxMessage } from "../src/email/inbox.js";

const mail = (index: number, subject: string, from: string, date: string): InboxMessage => ({
  uid: index,
  index,
  subject,
  from,
  date,
  seen: false,
});

test("daily mail brief deduplicates reply chains and shows exact plus elapsed time", () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const text = formatDailyMailSection([
    mail(1, "Customer ID: 94588 Reservation B1.1", "berlin@kapitel-zwei.de", "2026-07-17T13:55:00.000Z"),
    mail(2, "AW: Customer ID: 94588 Reservation B1.1", "berlin@kapitel-zwei.de", "2026-07-20T05:57:00.000Z"),
  ], [], { now, timeZone: "Europe/Istanbul" });

  assert.equal(text.match(/Dil kursu rezervasyonu/g)?.length, 1);
  assert.match(text, /20 Tem 2026 08:57 · 4 saat önce/);
  assert.equal(text.includes("AW:"), false);
  assert.equal(text.includes("reklamlar gizlendi"), false);
  assert.equal(text.includes("sessize alındı"), false);
  assert.equal(text.includes("Okumak için"), false);
});

test("daily mail brief shows at most three useful items with breathing room", () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const messages = [
    mail(1, "University application deadline", "one@uni.edu", "2026-07-20T09:00:00.000Z"),
    mail(2, "German course appointment", "two@goethe.de", "2026-07-20T08:00:00.000Z"),
    mail(3, "Visa appointment required", "three@auswaertiges-amt.de", "2026-07-20T07:00:00.000Z"),
    mail(4, "Application documents", "four@school.edu", "2026-07-20T06:00:00.000Z"),
    mail(5, "Summer sale", "promo@shop.example", "2026-07-20T09:30:00.000Z"),
  ];
  const text = formatDailyMailSection(messages, [], { now, timeZone: "Europe/Istanbul" });

  assert.equal(text.match(/^• /gm)?.length, 3);
  assert.match(text, /\n\n• /);
  assert.equal(text.includes("Summer sale"), false);
});

test("daily calendar omits empty groups, sources and ordinary holidays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-daily-brief-"));
  const memory = new MemoryStore(dir);
  const registry = new CalendarRegistry(memory.db);
  registry.upsertAccount({ id: "icloud", ownerId: "owner", source: "icloud", displayName: "iCloud", status: "connected" });
  registry.upsertCalendar({ id: "cal", accountId: "icloud", sourceCalendarId: "primary", name: "Ana", color: null, capabilities: { read: true, create: true, update: true, delete: true }, freshness: "fresh", sourceVersion: null });
  const put = (id: string, title: string, startAt: string) => registry.upsertEvent({ id, calendarId: "cal", sourceEventId: id, sourceVersion: null, eventJson: { title, allDay: true }, startsAt: startAt, endsAt: new Date(new Date(startAt).getTime() + 86_400_000).toISOString(), freshness: "fresh" });
  put("cancel", "CURSOR IPTAL", "2026-08-03T00:00:00.000Z");
  put("teeth", "Removal of the teeth caps", "2026-08-07T00:00:00.000Z");
  put("holiday", "Bölgesel tatil", "2026-08-15T00:00:00.000Z");

  const text = formatDailyCalendarSection(registry, { now: new Date("2026-07-20T10:00:00.000Z"), timeZone: "Europe/Istanbul" });
  assert.match(text, /CURSOR IPTAL/);
  assert.match(text, /Removal of the teeth caps/);
  assert.equal(text.includes("Bölgesel tatil"), false);
  assert.equal(text.includes("Bugün"), false);
  assert.equal(text.includes("Yarın"), false);
  assert.equal(text.includes("[iCloud]"), false);
  assert.match(text, /03 Ağu · 14 gün kaldı/);
  assert.match(text, /07 Ağu · 18 gün kaldı/);
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shown mail state is durable, bounded and filters delivered UIDs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-daily-state-"));
  const memory = new MemoryStore(dir);
  markDailyBriefMailsShown(memory, [1, 2, 2]);
  assert.deepEqual([...loadShownDailyBriefMailUids(memory)].sort(), ["1", "2"]);

  const groups = selectDailyMailGroups([
    mail(1, "University application", "admissions@uni.edu", "2026-07-20T09:00:00.000Z"),
    mail(2, "German course", "team@goethe.de", "2026-07-20T08:00:00.000Z"),
    mail(3, "Visa appointment", "office@example.de", "2026-07-20T07:00:00.000Z"),
  ], [], loadShownDailyBriefMailUids(memory));
  assert.deepEqual(groups.map((group) => group.message.uid), [3]);
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("new replies can appear while old members of their group are marked together", () => {
  const old = mail(1, "Reservation B1", "berlin@kapitel-zwei.de", "2026-07-19T08:00:00.000Z");
  const reply = mail(2, "AW: Reservation B1", "berlin@kapitel-zwei.de", "2026-07-20T08:00:00.000Z");
  const initial = selectDailyMailGroups([old, reply], [], new Set());
  assert.deepEqual(initial[0]?.uids.sort(), [1, 2]);
  assert.equal(selectDailyMailGroups([old, reply], [], new Set(["1", "2"])).length, 0);
  const newReply = mail(3, "Re: Reservation B1", "berlin@kapitel-zwei.de", "2026-07-21T08:00:00.000Z");
  assert.deepEqual(selectDailyMailGroups([old, reply, newReply], [], new Set(["1", "2"]))[0]?.message.uid, 3);
});

test("lightweight model labels mail purpose and invalid output falls back deterministically", async () => {
  const groups = selectDailyMailGroups([
    mail(4, "Customer ID 94588 Reservation B1", "berlin@kapitel-zwei.de", "2026-07-20T08:00:00.000Z"),
  ]);
  const config = {} as any;
  const labels = await labelDailyMailGroups(config, groups, {
    callModel: async () => '[{"id":"4","label":"Dil kursu rezervasyonu"}]',
    timeoutMs: 50,
  });
  assert.equal(labels.get("4"), "Dil kursu rezervasyonu");

  const fallback = await labelDailyMailGroups(config, groups, {
    callModel: async () => "not-json",
    timeoutMs: 50,
  });
  assert.equal(fallback.get("4"), "Dil kursu rezervasyonu");
});

test("mail labeling times out quickly and keeps deterministic fallback", async () => {
  const groups = selectDailyMailGroups([
    mail(5, "University application result", "admissions@uni.edu", "2026-07-20T08:00:00.000Z"),
  ]);
  const labels = await labelDailyMailGroups({} as any, groups, {
    callModel: async (_config, _prompt, options) => await new Promise<string>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    timeoutMs: 5,
  });
  assert.equal(labels.get("5"), "Üniversite başvurusu");
});

test("exact target hour schedules tomorrow instead of one minute later", () => {
  assert.equal(msUntilNextLocalHour(13, "Europe/Istanbul", new Date("2026-07-20T10:00:00.000Z")), 24 * 60 * 60_000);
  assert.equal(msUntilNextLocalHour(13, "Europe/Istanbul", new Date("2026-07-20T09:30:00.000Z")), 30 * 60_000);
  assert.equal(msUntilNextLocalHour(13, "Europe/Istanbul", new Date("2026-07-20T10:00:30.000Z")), (24 * 60 * 60 - 30) * 1000);
});
