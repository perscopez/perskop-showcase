import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import type { AppConfig } from "../config.js";
import { classifyMail, type MailClassification, type SenderRule } from "./classification.js";

export type InboxMessage = {
  uid: number;
  index: number;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
};

export type MailAttachment = {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
};

export function emailConfigured(config: AppConfig): boolean {
  return Boolean(
    config.EMAIL_ADDRESS && config.EMAIL_PASSWORD && config.EMAIL_IMAP_HOST,
  );
}

/**
 * Keep a lightweight IMAP IDLE connection open so Gmail can tell us about new
 * inbox messages without waiting for the periodic sync fallback.
 */
export function startInboxIdleWatcher(
  config: AppConfig,
  onInboxChanged: () => Promise<void> | void,
  onError: (error: unknown) => void = console.error,
): () => void {
  if (!emailConfigured(config)) return () => undefined;

  let stopped = false;
  let client: ImapFlow | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 5_000);
  };

  const connect = async () => {
    if (stopped) return;
    let ready = false;
    const next = new ImapFlow({
      host: config.EMAIL_IMAP_HOST,
      port: config.EMAIL_IMAP_PORT,
      secure: true,
      auth: {
        user: config.EMAIL_ADDRESS!,
        pass: config.EMAIL_PASSWORD!,
      },
      logger: false,
      maxIdleTime: 25 * 60 * 1000,
    });
    client = next;

    next.on("exists", () => {
      if (!ready || stopped) return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        changeTimer = null;
        Promise.resolve(onInboxChanged()).catch(onError);
      }, 1_000);
    });
    next.on("error", onError);
    next.on("close", scheduleReconnect);

    try {
      await next.connect();
      await next.mailboxOpen("INBOX", { readOnly: true });
      ready = true;
      // ImapFlow automatically enters IDLE when the selected mailbox is idle.
    } catch (error) {
      onError(error);
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (changeTimer) clearTimeout(changeTimer);
    const active = client;
    client = null;
    if (active) void active.logout().catch(() => undefined);
  };
}

function asUidList(result: false | number[]): number[] {
  return Array.isArray(result) ? result : [];
}

function toIsoDate(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

async function withImapClient<T>(
  config: AppConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  if (!emailConfigured(config)) {
    throw new Error("email not configured");
  }

  const client = new ImapFlow({
    host: config.EMAIL_IMAP_HOST,
    port: config.EMAIL_IMAP_PORT,
    secure: true,
    auth: {
      user: config.EMAIL_ADDRESS!,
      pass: config.EMAIL_PASSWORD!,
    },
    logger: false,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function messageFromFetch(
  msg: {
    uid: number;
    envelope?: { from?: { address?: string }[]; subject?: string; date?: Date };
    internalDate?: Date | string;
    flags?: Set<string>;
  },
): Promise<InboxMessage> {
  return {
    uid: msg.uid,
    index: 0,
    from: msg.envelope?.from?.[0]?.address ?? "unknown",
    subject: msg.envelope?.subject ?? "(konu yok)",
    date: toIsoDate(msg.internalDate ?? msg.envelope?.date),
    seen: Boolean(msg.flags?.has("\\Seen")),
  };
}

async function fetchMetaByUid(
  client: ImapFlow,
  uid: number,
): Promise<InboxMessage | null> {
  const msg = await client.fetchOne(
    uid,
    { envelope: true, flags: true, internalDate: true },
    { uid: true },
  );
  if (!msg) return null;
  return messageFromFetch(msg);
}

async function loadRecentMessages(
  client: ImapFlow,
  limit: number,
): Promise<InboxMessage[]> {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const mailbox = client.mailbox;
    const total = mailbox && typeof mailbox !== "boolean" ? mailbox.exists : 0;
    if (!total) return [];

    // Gmail: UID-list fetch often returns 0 on large mailboxes — use sequence numbers.
    const windowSize = Math.min(Math.max(limit * 4, 40), total);
    const start = Math.max(1, total - windowSize + 1);
    const rows: InboxMessage[] = [];

    for await (const msg of client.fetch(`${start}:*`, {
      envelope: true,
      flags: true,
      internalDate: true,
    })) {
      rows.push(await messageFromFetch(msg));
    }

    rows.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return rows.slice(0, limit).map((row, i) => ({ ...row, index: i + 1 }));
  } finally {
    lock.release();
  }
}

export async function fetchRecentInbox(
  config: AppConfig,
  limit = 15,
): Promise<InboxMessage[]> {
  return withImapClient(config, (client) => loadRecentMessages(client, limit));
}

export async function fetchMessageBody(
  config: AppConfig,
  uid: number,
): Promise<{
  subject: string;
  from: string;
  text: string;
  attachments: MailAttachment[];
}> {
  return withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(
        uid,
        { envelope: true, source: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw new Error(`mail bulunamadı (uid ${uid})`);
      }
      const parsed = await simpleParser(msg.source);
      const htmlText =
        typeof parsed.html === "string"
          ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          : "";
      const text = parsed.text?.trim() || htmlText || "(boş içerik)";
      const attachments = (parsed.attachments ?? []).map((att) => ({
        filename: att.filename ?? "attachment",
        contentType: att.contentType ?? "application/octet-stream",
        size: att.size ?? att.content?.length ?? 0,
        content: Buffer.isBuffer(att.content)
          ? att.content
          : Buffer.from(att.content ?? ""),
      }));
      return {
        subject: msg.envelope?.subject ?? parsed.subject ?? "(konu yok)",
        from: msg.envelope?.from?.[0]?.address ?? parsed.from?.text ?? "unknown",
        text: text.slice(0, 6000),
        attachments,
      };
    } finally {
      lock.release();
    }
  });
}

export async function fetchMessageByIndex(
  config: AppConfig,
  index: number,
  listLimit = 15,
): Promise<{ meta: InboxMessage; body: string }> {
  const list = await fetchRecentInbox(config, listLimit);
  const meta = list.find((m) => m.index === index);
  if (!meta) {
    throw new Error(
      `Liste ${list.length} mail gösteriyor; #${index} yok. /mail ile listeyi kontrol et.`,
    );
  }
  const full = await fetchMessageBody(config, meta.uid);
  return { meta, body: full.text };
}

export async function searchInbox(
  config: AppConfig,
  query: string,
  limit = 5,
): Promise<InboxMessage[]> {
  const q = query.trim();
  if (!q) return [];

  return withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      let uids = asUidList(await client.search({ subject: q }, { uid: true }));
      if (!uids.length) {
        uids = asUidList(await client.search({ body: q }, { uid: true }));
      }
      if (!uids.length) {
        uids = asUidList(
          await client.search({ or: [{ subject: q }, { body: q }] }, { uid: true }),
        );
      }
      if (!uids.length) return [];

      const pick = uids.slice(-Math.min(uids.length, limit * 2)).slice(-limit);
      const rows: InboxMessage[] = [];

      for (const uid of pick) {
        const row = await fetchMetaByUid(client, uid);
        if (row) rows.push(row);
      }

      rows.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      return rows.slice(0, limit).map((row, i) => ({ ...row, index: i + 1 }));
    } finally {
      lock.release();
    }
  });
}

function formatMailLine(message: InboxMessage, classification: MailClassification) {
  const flag = message.seen ? " " : "•";
  const when = message.date
    ? new Date(message.date).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
  const tags = [classification.category === "urgent" ? "acil" : null, classification.category === "priority" ? "önemli" : null].filter(Boolean).join(", ");
  return `${flag} #${message.index} ${message.subject}${tags ? ` (${tags})` : ""}\n   ${message.from} · ${when}`;
}

export function formatInboxBrief(messages: InboxMessage[], senderRules: SenderRule[] = []): string {
  if (!messages.length) return "Gelen kutusu boş (son kontrol).";

  const actionable = messages
    .map((message) => ({ message, classification: classifyMail(message, senderRules) }))
    .filter(({ classification }) => !classification.hidden)
    .sort((a, b) => b.classification.score - a.classification.score || new Date(b.message.date).getTime() - new Date(a.message.date).getTime());
  const hiddenPromos = messages.length - actionable.length;
  const urgent = actionable.filter(({ classification }) => classification.category === "urgent").slice(0, 5);
  const important = actionable.filter(({ classification }) => classification.category === "priority").slice(0, 6);
  const quietCount = actionable.length - urgent.length - important.length;

  const sections = [
    `📬 Mail özeti — reklamlar gizlendi${hiddenPromos ? ` (${hiddenPromos})` : ""}`,
    urgent.length ? `Acil / cevap gerekebilir\n${urgent.map(({ message, classification }) => formatMailLine(message, classification)).join("\n")}` : null,
    important.length ? `Üniversite / dil kursu / süreç\n${important.map(({ message, classification }) => formatMailLine(message, classification)).join("\n")}` : null,
  ].filter(Boolean);

  if (sections.length === 1) sections.push("Gösterilecek önemli mail yok.");
  if (quietCount > 0) sections.push(`Diğer ${quietCount} mail sessize alındı.`);
  sections.push("Okumak için: /mail 3");
  return sections.join("\n\n");
}

export function formatMessageDetail(
  meta: InboxMessage,
  body: string,
): string {
  const when = meta.date
    ? new Date(meta.date).toLocaleString("tr-TR")
    : "";
  const head = `📧 #${meta.index} — ${meta.subject}\nKim: ${meta.from}\nTarih: ${when}`;
  const trimmed = body.length > 3200 ? `${body.slice(0, 3200)}\n\n…(kısaltıldı)` : body;
  return `${head}\n\n---\n${trimmed}`;
}

/** Turkish mail intents — answer via IMAP, not Codex. */
export function parseMailIndex(text: string): number | null {
  const patterns = [
    /(\d+)\s*[\.\)]\s*(?:mail|mailin|deki mail)/i,
    /(\d+)\s*\.?\s*mail/i,
    /mail\s*#?\s*(\d+)/i,
    /(\d+)\.?(?:nin|nın|nun|nün|nci|ncı|ncu|ncü)\b/i,
    /(\d+)\s*de\b/i,
    /(\d+)de\b/i,
    /(\d+)\s+(?:nin|nın|nun|nün)\b/i,
    /(?:^|\s)(\d+)(?:\s+numara|\s*no)?\s*(?:içinde|içeri|içerik)/i,
    /(?:içinde|içerik|ne var|ne yaz)\D*(\d+)/i,
    /^(\d+)$/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function wantsMailContent(text: string): boolean {
  const lower = text.toLowerCase();
  return /içinde|içeri|içerik|ne var|ne yaz|yazıyor|oku|göster/i.test(lower);
}

export async function tryAnswerMailIntent(
  config: AppConfig,
  text: string,
): Promise<string | null> {
  if (!emailConfigured(config)) return null;

  const lower = text.toLowerCase();

  const listOnly =
    /^(mail(ler)?|gelen kutusu|inbox)$/i.test(lower) ||
    /^mail(leri)?\s*(listele|göster|bak)/i.test(lower);
  if (listOnly) {
    const messages = await fetchRecentInbox(config, 12);
    return formatInboxBrief(messages);
  }

  const index = parseMailIndex(text);
  if (
    index != null &&
    (wantsMailContent(text) || /mail|e-?posta|gmail|inbox|gelen/i.test(lower))
  ) {
    const { meta, body } = await fetchMessageByIndex(config, index, 15);
    return formatMessageDetail(meta, body);
  }

  if (index != null && wantsMailContent(text)) {
    const { meta, body } = await fetchMessageByIndex(config, index, 15);
    return formatMessageDetail(meta, body);
  }

  if (/mail.*(içinde|içeri|yazıyor|ne yaz)/i.test(lower) && index != null) {
    const { meta, body } = await fetchMessageByIndex(config, index, 15);
    return formatMessageDetail(meta, body);
  }

  const subjectQuoted = text.match(/["“](.+?)["”]/);
  const subjectHint =
    subjectQuoted?.[1]?.trim() ||
    (() => {
      const m = text.match(
        /(?:ile başlayan|başlığı|konusu|subject)\s+(.{4,80})/i,
      );
      return m?.[1]?.trim();
    })();

  if (subjectHint && /mail|e-?posta|gmail/i.test(lower)) {
    const hits = await searchInbox(config, subjectHint, 3);
    if (!hits.length) {
      return `“${subjectHint}” için mail bulunamadı. /mail ile güncel listeye bak.`;
    }
    if (hits.length === 1) {
      const full = await fetchMessageBody(config, hits[0].uid);
      return formatMessageDetail(hits[0], full.text);
    }
    const lines = hits.map(
      (h) => `${h.index}. ${h.subject} — ${h.from} (/mail read ile #)`,
    );
    return `Birden fazla eşleşme:\n${lines.join("\n")}\n\nTam okumak için: /mail <numara>`;
  }

  return null;
}
