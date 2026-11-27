import type { CalendarRegistry } from "../connectors/registry.js";
import type { InboxMessage } from "../email/inbox.js";
import { classifyMail, trackedSenderSource, type SenderRule } from "../email/classification.js";

type BriefOptions = { now?: Date; timeZone?: string };
type BriefEvent = ReturnType<CalendarRegistry["listEvents"]>[number];
export type DailyMailGroup = { message: InboxMessage; uids: number[]; score: number };

const REPLY_PREFIX = /^(?:(?:re|aw|wg|fw|fwd|sv|yanıt|cevap)\s*:\s*)+/i;
const IMPORTANT_EVENT = /\b(sınav|exam|deadline|son tarih|başvuru|application|randevu|appointment|diş|teeth|doğum günü|birthday|kurs|course|ders|lesson|iptal|cancel)\b/i;

function senderAddress(from: string): string {
  const bracketed = from.match(/<([^>]+)>/);
  const direct = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (bracketed?.[1] ?? direct?.[0] ?? from).trim().toLowerCase();
}

function normalizedSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim();
}

export function fallbackMailPurpose(message: InboxMessage): string {
  const subject = normalizedSubject(message.subject).toLocaleLowerCase("tr-TR");
  const source = trackedSenderSource(message.from);
  if (source === "Kapitel Zwei" && /reservation|reservierung|kayıt|booking|customer id/i.test(subject)) return "Dil kursu rezervasyonu";
  if (source === "Kapitel Zwei" || /language course|dil kursu|deutsch|german course|goethe|sprachschule|kurs/i.test(subject)) return "Dil kursu mesajı";
  if (/visa|vize|aufenthalt|residence permit/i.test(subject)) return /appointment|randevu|termin/i.test(subject) ? "Vize randevusu" : "Vize işlemi";
  if (/exam|sınav|prüfung/i.test(subject)) return "Sınav bilgisi";
  if (/deadline|son tarih|frist|action required|response required/i.test(subject)) return "Yanıt veya son tarih";
  if (/security|güvenlik|unusual sign-in|şüpheli/i.test(subject)) return "Güvenlik uyarısı";
  if (/university|üniversite|admission|application|başvuru|bewerbung|documents?|evrak/i.test(subject)) return "Üniversite başvurusu";
  return normalizedSubject(message.subject).slice(0, 70) || "Önemli mail";
}

function senderLabel(from: string): string {
  const tracked = trackedSenderSource(from);
  if (tracked) return tracked;
  const display = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  if (display) return display;
  const domain = senderAddress(from).split("@")[1]?.split(".")[0] ?? senderAddress(from);
  return domain ? domain.charAt(0).toLocaleUpperCase("tr-TR") + domain.slice(1) : "Mail";
}

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function mailTime(value: string, now: Date, timeZone: string): string {
  const date = validDate(value);
  if (!date) return "Tarih bilinmiyor";
  const exact = new Intl.DateTimeFormat("tr-TR", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  const elapsedMs = Math.max(0, now.getTime() - date.getTime());
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);
  return `${exact} · ${elapsedHours < 1 ? "1 saatten az önce" : `${elapsedHours} saat önce`}`;
}

export function selectDailyMailGroups(
  messages: InboxMessage[],
  senderRules: SenderRule[] = [],
  shownUids: ReadonlySet<string> = new Set(),
): DailyMailGroup[] {
  const byThread = new Map<string, DailyMailGroup>();

  for (const message of messages) {
    const classification = classifyMail(message, senderRules);
    if (classification.hidden || !["urgent", "priority"].includes(classification.category)) continue;
    const key = `${senderAddress(message.from)}\0${normalizedSubject(message.subject).toLocaleLowerCase("tr-TR")}`;
    const current = byThread.get(key);
    const messageTime = validDate(message.date)?.getTime() ?? 0;
    const currentTime = current ? validDate(current.message.date)?.getTime() ?? 0 : -1;
    if (!current) byThread.set(key, { message, score: classification.score, uids: [message.uid] });
    else {
      current.uids.push(message.uid);
      if (messageTime > currentTime) {
        current.message = message;
        current.score = classification.score;
      }
    }
  }

  return [...byThread.values()]
    .filter((group) => group.uids.some((uid) => !shownUids.has(String(uid))))
    .sort((a, b) => b.score - a.score || (validDate(b.message.date)?.getTime() ?? 0) - (validDate(a.message.date)?.getTime() ?? 0))
    .slice(0, 3);
}

export function formatSelectedDailyMailSection(
  selected: DailyMailGroup[],
  labels: ReadonlyMap<string, string> = new Map(),
  options: BriefOptions = {},
): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Europe/Istanbul";
  if (!selected.length) return "";

  const lines = selected.map(({ message }) => {
    const purpose = labels.get(String(message.uid)) ?? fallbackMailPurpose(message);
    return `• ${purpose} — ${senderLabel(message.from)}\n  ${mailTime(message.date, now, timeZone)}`;
  });
  return `📬 Önemli mailler\n\n${lines.join("\n\n")}`;
}

export function formatDailyMailSection(
  messages: InboxMessage[],
  senderRules: SenderRule[] = [],
  options: BriefOptions = {},
): string {
  return formatSelectedDailyMailSection(selectDailyMailGroups(messages, senderRules), new Map(), options);
}

function dayKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function calendarWhen(event: BriefEvent, now: Date, timeZone: string): string {
  const start = new Date(event.startAt);
  const key = dayKey(start, timeZone);
  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(addDays(now, 1), timeZone);
  const exactDay = new Intl.DateTimeFormat("tr-TR", { timeZone, day: "2-digit", month: "short" }).format(start);
  const dayNumber = (keyValue: string) => Date.parse(`${keyValue}T00:00:00.000Z`);
  const remaining = Math.max(0, Math.round((dayNumber(key) - dayNumber(today)) / 86_400_000));
  const relative = key === today ? "Bugün" : key === tomorrow ? "Yarın" : `${remaining} gün kaldı`;
  const day = key === today || key === tomorrow ? relative : `${exactDay} · ${relative}`;
  if (event.allDay) return day;
  const time = new Intl.DateTimeFormat("tr-TR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(start);
  return key === today || key === tomorrow ? `${relative} ${time}` : `${exactDay} ${time} · ${relative}`;
}

export function formatDailyCalendarSection(registry: CalendarRegistry, options: BriefOptions = {}): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Europe/Istanbul";
  const end = addDays(now, 60);
  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(addDays(now, 1), timeZone);
  const selected = registry
    .listEvents("owner", now.toISOString(), end.toISOString())
    .filter((event) => {
      const key = dayKey(new Date(event.startAt), timeZone);
      return key === today || key === tomorrow || IMPORTANT_EVENT.test(event.title);
    })
    .slice(0, 4);
  if (!selected.length) return "";
  return `📅 Takvim\n\n${selected.map((event) => `• ${event.title}\n  ${calendarWhen(event, now, timeZone)}`).join("\n\n")}`;
}

export function formatDailyBriefTitle(now = new Date(), timeZone = "Europe/Istanbul"): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(now);
}
