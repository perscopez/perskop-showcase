import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../db.js";
import {
  fetchMessageByIndex,
  fetchRecentInbox,
  formatInboxBrief,
  formatMessageDetail,
} from "../email/inbox.js";
import { routePrompt } from "../providers/router.js";
import { CalendarRegistry } from "../connectors/registry.js";
import { formatCalendarBrief } from "../connectors/calendar/brief.js";
import { prepareDailyBrief } from "../cron/scheduler.js";
import { markDailyBriefMailsShown } from "../cron/dailyBriefState.js";
import { GmailStore } from "../email/gmailStore.js";
import { conversationMemoryContent, redactConversationSecrets } from "../memory/conversation.js";
import { withTelegramProgress } from "./progress.js";
import { formatMemoryList, memoryQuery, rememberText } from "./memoryCommands.js";
import { formatBotStatus } from "./status.js";
import { getDiskPressureInfo } from "../storage/diskPressure.js";
import { RemoteSessionStore } from "../remote/sessionStore.js";
import { formatRemoteSessions, remoteSessionPrefix, remoteSessionPrompt } from "./remoteCommands.js";
import { putRemotePromptPayload, waitForRemoteCommandResult } from "../remote/commandBroker.js";
import { formatTaskDetail, formatTaskList, formatNodeList } from "./taskCommands.js";
import { splitTelegramMessage } from "./messageChunks.js";
import { NodeService } from "../tasks/nodeService.js";
import { TaskService } from "../tasks/taskService.js";

function isAllowed(config: AppConfig, userId: number): boolean {
  // Fail closed: an empty allowlist means nobody may use the bot.
  if (config.allowedTelegramUserIds.length === 0) return false;
  return config.allowedTelegramUserIds.includes(userId);
}

export function registerTelegramHandlers(
  bot: Bot,
  config: AppConfig,
  memory: MemoryStore,
) {
  const remote = new RemoteSessionStore(memory.db);
  const nodes = new NodeService(memory);
  const tasks = new TaskService(memory);
  bot.command("start", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) {
      await ctx.reply("Bu bot private. Erişim yok.");
      return;
    }
    await ctx.reply(
      "perskop hazır.\n\n/brief — günlük özet\n/calendar — takvim\n/mail — hızlı mail listesi\n/memory — hafızayı incele\n/remember — kalıcı bilgi öğret\n/nodes — Mac node durumu\n/tasks — görevler\n/cancel — görev iptal\n/sessions — Mac oturumları\n/send — Mac oturumuna komut gönder",
    );
  });

  bot.command("mail", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const args = ctx.message?.text?.replace(/^\/mail\s*/i, "").trim() ?? "";
    const num = Number(args);
    try {
      if (args && Number.isFinite(num) && num > 0) {
        memory.setMailFocus(`telegram:${ctx.chat.id}`, num);
        const { meta, body } = await fetchMessageByIndex(config, num, 15);
        await ctx.reply(formatMessageDetail(meta, body));
        return;
      }
      const messages = await fetchRecentInbox(config, 12);
      await ctx.reply(formatInboxBrief(messages, new GmailStore(memory.db).listSenderRules()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Mail hatası: ${message}`);
    }
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    new GmailStore(memory.db); // Ensure mail status tables also exist on a fresh installation.
    memory.providerRuntime.clearElapsedCooldowns();
    const states = [
      ...memory.providerRuntime.listFor(config.PERSKOP_NODE_ID ?? "vps", "conversation"),
      ...memory.providerRuntime.listFor(config.PERSKOP_NODE_ID ?? "vps", "factual"),
    ];
    const providers = [...new Set(states.map((state) => state.provider))].map((provider) => {
      const rows = states.filter((state) => state.provider === provider);
      const rank = { unavailable: 3, cooldown: 2, healthy: 1, unknown: 0 } as const;
      const state = rows.sort((a, b) => rank[b.status] - rank[a.status])[0];
      return { provider, status: state.status, error: state.last_error_kind };
    });
    const gmail = memory.db.prepare(`
      SELECT COUNT(*) AS count, MAX(g.last_sync_at) AS last_sync
      FROM connector_accounts a LEFT JOIN gmail_accounts g ON g.account_id=a.id
      WHERE a.owner_id='owner' AND a.source='google_mail' AND a.status='connected'
    `).get() as { count: number; last_sync: string | null };
    let disk: ReturnType<typeof getDiskPressureInfo> | null = null;
    try { disk = getDiskPressureInfo(config.DATA_DIR); } catch { /* status remains useful */ }
    const memoryCount = (memory.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE user_id='owner'").get() as { count: number }).count;
    const mac = remote.listNodes()[0] as any;
    const macLastSeenMs = mac ? Date.parse(String(mac.last_seen_at || "")) : Number.NaN;
    await ctx.reply(formatBotStatus({
      diskPct: disk?.pct,
      diskFreeGb: disk ? disk.freeBytes / 1024 / 1024 / 1024 : undefined,
      gmailConnected: gmail.count,
      gmailLastSync: gmail.last_sync,
      imapLastSync: memory.getLastMailSyncTime(),
      memoryCount,
      macOnline: Number.isFinite(macLastSeenMs) && Date.now() - macLastSeenMs < 60_000,
      macSessionCount: Number(mac?.session_count || 0),
      macLastSeen: mac?.last_seen_at ?? null,
      providers,
    }));
  });

  bot.command("memory", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const query = memoryQuery(ctx.message?.text ?? "");
    const items = memory.retrieveScopedMemories({
      userId: "owner",
      projectId: config.DATA_DIR,
      query: query || undefined,
      limit: 8,
    });
    await ctx.reply(formatMemoryList(items));
  });

  bot.command("remember", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const content = rememberText(ctx.message?.text ?? "");
    if (!content) {
      await ctx.reply("Örnek: /remember Üniversite ve dil kursu mailleri şu an önemli");
      return;
    }
    const item = memory.addMemory({
      source: "telegram",
      userId: "owner",
      projectId: "global",
      memoryType: "preference",
      title: content.slice(0, 80),
      content,
      provider: "owner",
    });
    await ctx.reply(`🧠 Kaydettim (#${item.id}). Bundan sonraki Perskop ajanları bu bilgiyi kullanabilir.`);
  });

  bot.command("sessions", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    await ctx.reply(formatRemoteSessions(remote.listSessions()));
  });

  bot.command("nodes", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    await ctx.reply(formatNodeList(nodes.listNodes() as Array<Record<string, any>>));
  });

  bot.command("tasks", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const arg = (ctx.message?.text ?? "").replace(/^\/tasks(?:@[a-zA-Z0-9_]+)?\s*/i, "").trim();
    if (arg) {
      const taskId = Number(arg.replace(/^#/, ""));
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        await ctx.reply("Kullanım: /tasks veya /tasks <görev-id>");
        return;
      }
      const item = memory.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, any> | undefined;
      await ctx.reply(formatTaskDetail(item));
      return;
    }
    await ctx.reply(formatTaskList(memory.listTasks(8) as Array<Record<string, any>>));
  });

  bot.command("cancel", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const arg = (ctx.message?.text ?? "").replace(/^\/cancel(?:@[a-zA-Z0-9_]+)?\s*/i, "").trim().replace(/^#/, "");
    const taskId = Number(arg);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      await ctx.reply("Kullanım: /cancel <görev-id>");
      return;
    }
    const current = memory.db.prepare("SELECT status,revision FROM tasks WHERE id=?").get(taskId) as
      | { status: string; revision: number }
      | undefined;
    if (!current) {
      await ctx.reply("Görev bulunamadı.");
      return;
    }
    const result = tasks.transition(taskId, {
      to: "cancelled",
      expectedRevision: current.revision,
      fields: { cancellation_state: "cancelled" },
    });
    if (!result.applied && result.reason !== "duplicate_event") {
      await ctx.reply(`İptal edilemedi (#${taskId}): ${result.reason} · durum ${result.status}`);
      return;
    }
    nodes.appendTaskEvent({
      taskId,
      eventType: "cancelled",
      revision: result.revision,
      payload: { by: "telegram" },
    });
    try {
      const executorUrl = config.PERSKOP_EXECUTOR_URL || "http://sandbox-executor:18788";
      await fetch(`${executorUrl}/cancel/${taskId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.PERSKOP_EXECUTOR_TOKEN}` },
      });
    } catch {
      // Gateway cancellation is authoritative even if executor is unreachable.
    }
    await ctx.reply(`⛔️ Görev #${taskId} iptal edildi.`);
  });

  bot.command("open", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const prefix = remoteSessionPrefix(ctx.message?.text ?? "");
    if (!prefix) {
      await ctx.reply("Önce /sessions yaz, sonra örneğin /open abcdef12 kullan.");
      return;
    }
    const session = remote.findSession(prefix);
    if (!session) {
      await ctx.reply("Bu kısa kimlik tek bir oturumla eşleşmedi. /sessions listesini yenile.");
      return;
    }
    const lastSeen = Date.parse(String(session.last_seen_at || ""));
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= 60_000) {
      await ctx.reply("Mac şu an çevrimdışı görünüyor. Komut gönderilmedi.");
      return;
    }
    remote.queueCommand({ nodeId: session.node_id, action: "focus_session", sessionId: session.session_id });
    await ctx.reply(`Mac'te “${String(session.title || "İsimsiz oturum").slice(0, 80)}” açılıyor.`);
  });

  bot.command("session", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const prefix = (ctx.message?.text ?? "").replace(/^\/session(?:@[a-zA-Z0-9_]+)?\s*/i, "").trim();
    if (!prefix) {
      await ctx.reply("Önce /sessions yaz, sonra örneğin /session abcdef12 kullan.");
      return;
    }
    const session = remote.findSession(prefix);
    if (!session) {
      await ctx.reply("Bu kısa kimlik tek bir oturumla eşleşmedi. /sessions listesini yenile.");
      return;
    }
    const lastSeen = Date.parse(String(session.last_seen_at || ""));
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= 60_000) {
      await ctx.reply("Mac çevrimdışı; oturum özeti alınamadı.");
      return;
    }
    const command = remote.queueCommand({ nodeId: session.node_id, action: "read_session", sessionId: session.session_id });
    await ctx.replyWithChatAction("typing");
    const outcome = await waitForRemoteCommandResult(String(command.id));
    if (!outcome) {
      await ctx.reply("Mac zamanında yanıt vermedi. /session komutunu tekrar deneyebilirsin.");
    } else if (!outcome.ok) {
      await ctx.reply(`Oturum okunamadı: ${outcome.error || "bilinmeyen hata"}`);
    } else {
      await ctx.reply(String(outcome.result || "Bu oturumda gösterilecek mesaj yok.").slice(0, 4000));
    }
  });

  bot.command("send", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const parsed = remoteSessionPrompt(ctx.message?.text ?? "");
    if (!parsed) {
      await ctx.reply("Kullanım: /send <oturum-kodu> <komut>\nÖrnek: /send ef123456 testleri çalıştır ve devam et");
      return;
    }
    if (parsed.prompt.length > 12_000) {
      await ctx.reply("Komut çok uzun. En fazla 12.000 karakter gönderebilirsin.");
      return;
    }
    const session = remote.findSession(parsed.selector);
    if (!session) {
      await ctx.reply("Bu kısa kimlik tek bir oturumla eşleşmedi. /sessions listesini yenile.");
      return;
    }
    const lastSeen = Date.parse(String(session.last_seen_at || ""));
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= 60_000) {
      await ctx.reply("Mac şu an çevrimdışı görünüyor. Komut gönderilmedi.");
      return;
    }
    const command = remote.queueCommand({
      nodeId: String(session.node_id),
      action: "send_prompt",
      sessionId: String(session.session_id),
    });
    putRemotePromptPayload(String(command.id), parsed.prompt);
    await ctx.reply(`“${String(session.title || "İsimsiz oturum").slice(0, 80)}” oturumuna gönderiliyor.`);

    void (async () => {
      const outcome = await waitForRemoteCommandResult(String(command.id), 15 * 60_000);
      if (!outcome) {
        await ctx.reply("Ajan 15 dakika içinde tamamlanmadı. Oturumu /session ile kontrol edebilirsin.");
      } else if (!outcome.ok) {
        await ctx.reply(`Komut tamamlanamadı: ${outcome.error || "bilinmeyen hata"}`);
      } else if (!outcome.result) {
        await ctx.reply("Komut tamamlandı; ajan metin yanıtı üretmedi.");
      } else {
        for (const chunk of splitTelegramMessage(outcome.result)) await ctx.reply(chunk);
      }
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Yanıt alınamadı: ${message.slice(0, 500)}`);
    });
  });

  bot.command("newsession", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const node = remote.listNodes().find((item: any) => Date.now() - Date.parse(String(item.last_seen_at || "")) < 60_000) as any;
    if (!node) {
      await ctx.reply("Mac şu an çevrimdışı görünüyor.");
      return;
    }
    remote.queueCommand({ nodeId: String(node.id), action: "new_session" });
    await ctx.reply("Mac'te yeni Perskop oturumu açılıyor.");
  });

  bot.command("calendar", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    await ctx.reply(formatCalendarBrief(new CalendarRegistry(memory.db), { timeZone: config.CRON_TZ }));
  });

  bot.command("brief", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    try {
      const prepared = await prepareDailyBrief({ config, memory });
      await ctx.reply(prepared.text);
      markDailyBriefMailsShown(memory, prepared.shownMailUids);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Brief hatası: ${message}`);
    }
  });

  const pendingApprovals = new Map<
    string,
    { prompt: string; preferred?: any }
  >();

  bot.command("approve", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const key = ctx.message?.text?.replace(/^\/approve\s*/i, "").trim();
    if (!key) {
      await ctx.reply("Lütfen onay anahtarını belirtin (örn: `/approve pending-...`)");
      return;
    }
    await handleApproval(ctx, key);
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const data = ctx.callbackQuery.data;
    if (data.startsWith("approve:")) {
      const key = data.slice("approve:".length);
      await handleApproval(ctx, key);
    } else if (data.startsWith("deny:")) {
      const key = data.slice("deny:".length);
      pendingApprovals.delete(key);
      await ctx.answerCallbackQuery({ text: "İşlem reddedildi." });
      await ctx.reply("❌ İşlem kullanıcı tarafından reddedildi.");
    }
  });

  async function handleApproval(ctx: any, key: string) {
    const pending = pendingApprovals.get(key);
    if (!pending) {
      await ctx.reply("Geçersiz veya süresi dolmuş onay anahtarı.");
      return;
    }
    pendingApprovals.delete(key);
    if (ctx.answerCallbackQuery) {
      await ctx.answerCallbackQuery({ text: "İşlem onaylandı, çalıştırılıyor..." });
    }
    await ctx.reply("✅ İşlem onaylandı, çalıştırılıyor...");

    const taskId = memory.addTask({
      source: "telegram",
      prompt: pending.prompt,
    });

    try {
      const result = await withTelegramProgress(ctx, () => routePrompt(config, pending.prompt, pending.preferred, {
          mailFocusKey: `telegram:${ctx.chat.id}`,
          memory,
          approved: true,
          idempotencyKey: key,
        }));
      memory.completeTask(taskId, {
        response: result.output,
        provider: result.provider,
      });

      const title = redactConversationSecrets(pending.prompt).slice(0, 80);
      memory.addMemory({
        source: "telegram",
        title,
        content: conversationMemoryContent({ prompt: pending.prompt, response: result.output, provider: result.provider }),
        provider: result.provider,
        memoryType: "conversation",
      });

      const reply =
        result.output.length > 3500
          ? `${result.output.slice(0, 3500)}\n\n…(kısaltıldı)`
          : result.output;

      await ctx.reply(`[${result.provider}]\n${reply}`);
    } catch (err: any) {
      const message = err.message || String(err);
      memory.failTask(taskId, message);
      await ctx.reply(`Hata: ${message}`);
    }
  }

  bot.on("message:text", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    const text = ctx.message.text.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      await ctx.reply(
        "Bu komutu tanımıyorum. Komutlar: /brief, /calendar, /mail, /memory, /remember, /status, /nodes, /tasks, /cancel, /sessions, /session, /send, /open, /newsession",
      );
      return;
    }

    const taskId = memory.addTask({
      source: "telegram",
      prompt: text,
    });

    try {
      const preferred =
        memory.getCloudProvider() ?? config.DEFAULT_PROVIDER;
      const result = await withTelegramProgress(ctx, () => routePrompt(config, text, preferred, {
          mailFocusKey: `telegram:${ctx.chat.id}`,
          memory,
        }));
      memory.completeTask(taskId, {
        response: result.output,
        provider: result.provider,
      });

      const title = redactConversationSecrets(text).slice(0, 80);
      memory.addMemory({
        source: "telegram",
        title,
        content: conversationMemoryContent({ prompt: text, response: result.output, provider: result.provider }),
        provider: result.provider,
        memoryType: "conversation",
      });

      const reply =
        result.output.length > 3500
          ? `${result.output.slice(0, 3500)}\n\n…(kısaltıldı)`
          : result.output;

      await ctx.reply(`[${result.provider}]\n${reply}`);
    } catch (err: any) {
      const message = err.message || String(err);
      if (message.startsWith("APPROVAL_REQUIRED:")) {
        const [_, workload, key] = message.split(":");
        memory.failTask(taskId, "Pending user approval");
        pendingApprovals.set(key, { prompt: text, preferred: memory.getCloudProvider() ?? config.DEFAULT_PROVIDER });
        
        await ctx.reply(
          `⚠️ Bu işlem onay gerektiriyor (${workload}).\nOnaylamak için aşağıdaki butona tıklayın veya \`/approve ${key}\` yazın.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Onayla ✅", callback_data: `approve:${key}` },
                  { text: "Reddet ❌", callback_data: `deny:${key}` },
                ],
              ],
            },
          }
        );
        return;
      }
      memory.failTask(taskId, message);
      await ctx.reply(`Hata: ${message}`);
    }
  });

  bot.on("message", async (ctx) => {
    if (!ctx.from || !isAllowed(config, ctx.from.id)) return;
    await ctx.reply(
      "Şimdilik yazılı mesajları işleyebiliyorum. Ses, fotoğraf ve dosya desteği sıradaki geliştirmeler arasında.",
    );
  });
}
