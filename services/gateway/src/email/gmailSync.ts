import type { MemoryStore } from "../db.js";
import {
  GmailApiError,
  type GmailClient,
  type GmailMessage,
  type GmailMessagePart,
  type GmailThread,
} from "../connectors/google/gmail.js";
import { classifyMail, type SenderRule } from "./classification.js";
import { GmailStore, type StoredGmailMessage, type StoredGmailThread } from "./gmailStore.js";

function header(part: GmailMessagePart | undefined, name: string): string {
  return part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function textBody(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType?.toLowerCase() === "text/plain" && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const value = textBody(child);
    if (value) return value;
  }
  return decodeBody(part.body?.data);
}

function isoDate(message: GmailMessage): string {
  const value = Number(message.internalDate ?? 0);
  if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  const dateHeader = header(message.payload, "Date");
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

export function normalizeGmailThread(accountId: string, thread: GmailThread, senderRules: SenderRule[] = []): StoredGmailThread {
  const messages: StoredGmailMessage[] = [...(thread.messages ?? [])]
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))
    .map((message) => ({
      messageId: message.id,
      threadId: message.threadId,
      rfcMessageId: header(message.payload, "Message-ID") || null,
      internalDate: isoDate(message),
      subject: header(message.payload, "Subject") || "(Konu yok)",
      from: header(message.payload, "From") || "(Gönderen bilinmiyor)",
      snippet: message.snippet ?? "",
      labelIds: message.labelIds ?? [],
      bodyText: textBody(message.payload).slice(0, 20_000),
      payload: message.payload ?? {},
    }));
  const latest = messages.at(-1) ?? {
    messageId: "",
    threadId: thread.id,
    rfcMessageId: null,
    internalDate: new Date(0).toISOString(),
    subject: "(Konu yok)",
    from: "(Gönderen bilinmiyor)",
    snippet: thread.snippet ?? "",
    labelIds: [],
    bodyText: "",
    payload: {},
  };
  const labelIds = [...new Set(messages.flatMap((message) => message.labelIds))];
  const classification = classifyMail({
    subject: latest.subject,
    from: latest.from,
    snippet: latest.snippet,
    labels: labelIds,
    seen: !labelIds.includes("UNREAD"),
  }, senderRules);
  return {
    accountId,
    threadId: thread.id,
    historyId: thread.historyId ?? null,
    subject: latest.subject,
    from: latest.from,
    snippet: latest.snippet || thread.snippet || "",
    lastMessageAt: latest.internalDate,
    labelIds,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    hidden: classification.hidden,
    category: classification.category,
    score: classification.score,
    reasons: classification.reasons,
    messages,
  };
}

function affectedThreadIds(history: Awaited<ReturnType<GmailClient["listHistory"]>>["history"]): Set<string> {
  const ids = new Set<string>();
  for (const item of history) {
    for (const message of item.messages ?? []) ids.add(message.threadId);
    for (const event of item.messagesAdded ?? []) ids.add(event.message.threadId);
    for (const event of item.messagesDeleted ?? []) ids.add(event.message.threadId);
    for (const event of item.labelsAdded ?? []) ids.add(event.message.threadId);
    for (const event of item.labelsRemoved ?? []) ids.add(event.message.threadId);
  }
  return ids;
}

async function fullSync(input: {
  store: GmailStore;
  client: GmailClient;
  accountId: string;
  emailAddress: string;
  historyId: string;
  maxThreads: number;
  senderRules: SenderRule[];
}) {
  const listed = await input.client.listThreads({ maxResults: input.maxThreads, includeSpamTrash: true });
  let threadCount = 0;
  for (const item of listed.threads) {
    const thread = await input.client.getThread(item.id);
    input.store.upsertThread(normalizeGmailThread(input.accountId, thread, input.senderRules));
    threadCount += 1;
  }
  input.store.upsertAccount({ accountId: input.accountId, emailAddress: input.emailAddress, historyId: input.historyId });
  return threadCount;
}

export async function syncGmailAccount(input: {
  memory: MemoryStore;
  client: GmailClient;
  accountId: string;
  maxThreads?: number;
}): Promise<{ mode: "full" | "incremental"; threadCount: number; recoveredFromExpiredHistory?: boolean }> {
  const store = new GmailStore(input.memory.db);
  const senderRules = store.listSenderRules();
  const previous = store.getAccount(input.accountId);
  const profile = await input.client.getProfile();
  const labels = await input.client.listLabels();
  store.replaceLabels(input.accountId, labels);
  const maxThreads = Math.min(Math.max(input.maxThreads ?? 100, 1), 500);

  if (!previous?.historyId) {
    const threadCount = await fullSync({ store, client: input.client, accountId: input.accountId, emailAddress: profile.emailAddress, historyId: profile.historyId, maxThreads, senderRules });
    return { mode: "full", threadCount };
  }

  try {
    const history = await input.client.listHistory(previous.historyId);
    const threadIds = affectedThreadIds(history.history);
    let threadCount = 0;
    for (const threadId of threadIds) {
      try {
        const thread = await input.client.getThread(threadId);
        store.upsertThread(normalizeGmailThread(input.accountId, thread, senderRules));
        threadCount += 1;
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) store.deleteThread(input.accountId, threadId);
        else throw error;
      }
    }
    store.upsertAccount({
      accountId: input.accountId,
      emailAddress: profile.emailAddress,
      historyId: history.historyId ?? profile.historyId,
    });
    return { mode: "incremental", threadCount };
  } catch (error) {
    const expired = error instanceof GmailApiError && error.status === 404 && ["historyIdInvalid", "notFound"].includes(error.reason ?? "");
    if (!expired) throw error;
    const threadCount = await fullSync({ store, client: input.client, accountId: input.accountId, emailAddress: profile.emailAddress, historyId: profile.historyId, maxThreads, senderRules });
    return { mode: "full", threadCount, recoveredFromExpiredHistory: true };
  }
}

export async function refreshGmailThread(input: {
  memory: MemoryStore;
  client: GmailClient;
  accountId: string;
  threadId: string;
}): Promise<StoredGmailThread | null> {
  const store = new GmailStore(input.memory.db);
  try {
    const normalized = normalizeGmailThread(input.accountId, await input.client.getThread(input.threadId), store.listSenderRules());
    store.upsertThread(normalized);
    return normalized;
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      store.deleteThread(input.accountId, input.threadId);
      return null;
    }
    throw error;
  }
}
