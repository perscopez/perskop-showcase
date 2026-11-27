import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../db.js";
import { emailConfigured, fetchRecentInbox, formatInboxBrief } from "../email/inbox.js";
import { CalendarRegistry } from "../connectors/registry.js";
import { formatCalendarBrief } from "../connectors/calendar/brief.js";
import { GmailStore } from "../email/gmailStore.js";
import { formatDailyBriefTitle, formatDailyCalendarSection, formatSelectedDailyMailSection, selectDailyMailGroups } from "./dailyBrief.js";
import { labelDailyMailGroups } from "./dailyBriefLabels.js";
import { loadShownDailyBriefMailUids, markDailyBriefMailsShown } from "./dailyBriefState.js";
import { claimCronRun, completeCronRun, dailyBriefRunKey, ensureDailyBriefJob } from "./runLease.js";

type CronDeps = {
  config: AppConfig;
  memory: MemoryStore;
  bot?: Bot;
  log: { info: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };
  briefHour?: number;
  now?: Date;
};

const dailyBriefTimers = new Map<number, ReturnType<typeof setTimeout>>();

function parseMorningHour(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length >= 2) {
    const hour = Number(parts[1]);
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) return hour;
  }
  return 8;
}

export function msUntilNextLocalHour(hour: number, timeZone: string, now = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const s = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  const nowSeconds = h * 3600 + m * 60 + s;
  const targetSeconds = hour * 3600;
  let deltaSeconds = targetSeconds - nowSeconds;
  if (deltaSeconds <= 0) deltaSeconds += 24 * 3600;
  return deltaSeconds * 1000;
}

async function notifyTelegram(deps: CronDeps, text: string) {
  const chatId = deps.config.TELEGRAM_NOTIFY_CHAT_ID;
  if (!deps.bot || !chatId) {
    deps.log.info("cron: no telegram chat id, skipping push");
    return false;
  }
  const body = text.length > 3800 ? `${text.slice(0, 3800)}…` : text;
  await deps.bot.api.sendMessage(chatId, body);
  return true;
}

export type PreparedDailyBrief = { text: string; shownMailUids: number[] };

export async function prepareDailyBrief(deps: Pick<CronDeps, "config" | "memory">): Promise<PreparedDailyBrief> {
  const now = new Date();
  const calendar = formatDailyCalendarSection(new CalendarRegistry(deps.memory.db), { now, timeZone: deps.config.CRON_TZ });
  const sections = [calendar];
  let shownMailUids: number[] = [];

  if (deps.config.CRON_EMAIL_ENABLED && emailConfigured(deps.config)) {
    const messages = await fetchRecentInbox(deps.config, 25);
    const groups = selectDailyMailGroups(messages, new GmailStore(deps.memory.db).listSenderRules(), loadShownDailyBriefMailUids(deps.memory));
    const labels = await labelDailyMailGroups(deps.config, groups);
    sections.push(formatSelectedDailyMailSection(groups, labels, { now, timeZone: deps.config.CRON_TZ }));
    shownMailUids = groups.flatMap((group) => group.uids);
  }

  return { text: sections.filter(Boolean).join("\n\n") || "Yeni önemli gelişme yok.", shownMailUids };
}

export async function buildDailyBrief(deps: Pick<CronDeps, "config" | "memory">) {
  return (await prepareDailyBrief(deps)).text;
}

export async function runDailyBrief(deps: CronDeps) {
  const now = deps.now ?? new Date();
  const hour = deps.briefHour ?? new Date(now.toLocaleString("en-US", { timeZone: deps.config.CRON_TZ })).getHours();
  const runKey = dailyBriefRunKey(hour, deps.config.CRON_TZ, now);
  const jobId = ensureDailyBriefJob(deps.memory, hour);
  const claim = claimCronRun(deps.memory, { jobId, runKey });
  if (!claim.claimed) {
    deps.log.info({ runKey, reason: claim.reason }, "cron: daily brief skipped (lease)");
    return { skipped: true, runKey, reason: claim.reason };
  }

  const title = formatDailyBriefTitle(now, deps.config.CRON_TZ);
  try {
    const prepared = await prepareDailyBrief(deps);
    const brief = prepared.text;
    deps.memory.addMemory({ source: "system", title: `Günlük brief ${title}`, content: brief, provider: "daily-brief" });
    const delivered = await notifyTelegram(deps, `🧭 ${title}\n\n${brief}`);
    if (delivered) markDailyBriefMailsShown(deps.memory, prepared.shownMailUids);
    completeCronRun(deps.memory, runKey, {
      status: delivered ? "succeeded" : "skipped",
      result: delivered ? "delivered" : "no_telegram_chat",
    });
    deps.log.info({ runKey }, "cron: daily brief sent");
    return { skipped: false, runKey, delivered };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeCronRun(deps.memory, runKey, { status: "failed", result: message });
    deps.log.error({ err: message, runKey }, "cron: daily brief failed");
    await notifyTelegram(deps, `⚠️ Günlük brief başarısız: ${message}`).catch(() => undefined);
    return { skipped: false, runKey, error: message };
  }
}

// Backwards-compatible exports for older callers/tests. Scheduled pushes use runDailyBrief.
export async function runMorningEmailBrief(deps: CronDeps) {
  if (!deps.config.CRON_EMAIL_ENABLED) return;
  try {
    const messages = await fetchRecentInbox(deps.config, 25);
    const brief = formatInboxBrief(messages, new GmailStore(deps.memory.db).listSenderRules());
    const title = "Mail özeti";
    deps.memory.addMemory({ source: "system", title, content: brief, provider: "email" });
    await notifyTelegram(deps, `📬 ${title}\n\n${brief}`);
    deps.log.info("cron: email brief sent");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error({ err: message }, "cron: email brief failed");
    await notifyTelegram(deps, `⚠️ Mail kontrolü başarısız: ${message}`).catch(() => undefined);
  }
}

export async function runCalendarBrief(deps: CronDeps) {
  const title = "Takvim özeti";
  const brief = formatCalendarBrief(new CalendarRegistry(deps.memory.db), { timeZone: deps.config.CRON_TZ });
  deps.memory.addMemory({ source: "system", title, content: brief, provider: "calendar" });
  await notifyTelegram(deps, brief);
  deps.log.info("cron: calendar brief sent");
}

function calendarHours(value: string) {
  const hours = value.split(",").map((part) => Number(part.trim())).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  return [...new Set(hours.length ? hours : [13, 22])];
}

function scheduleDailyBrief(deps: CronDeps, hour: number) {
  const oldTimer = dailyBriefTimers.get(hour); if (oldTimer) clearTimeout(oldTimer);
  const delay = msUntilNextLocalHour(hour, deps.config.CRON_TZ);
  deps.log.info({ hour, delayMs: delay }, "cron: next daily brief scheduled");
  dailyBriefTimers.set(hour, setTimeout(async () => {
    await runDailyBrief({ ...deps, briefHour: hour });
    scheduleDailyBrief(deps, hour);
  }, delay));
}

export function startCronScheduler(deps: CronDeps) {
  for (const hour of calendarHours(deps.config.CRON_CALENDAR_BRIEF_HOURS)) scheduleDailyBrief(deps, hour);
}
