import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { Bot } from "grammy";
import { registerApiRoutes } from "./api/routes.js";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./db.js";
import { registerTelegramHandlers } from "./telegram/bot.js";
import { startCronScheduler } from "./cron/scheduler.js";
import { formatTrackedMailAlert, startEmailSyncScheduler } from "./email/syncWorker.js";
import { startGmailBackgroundSyncScheduler } from "./email/gmailScheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TELEGRAM_RESTART_DELAY_MS = 5_000;

async function keepTelegramPolling(bot: Bot, app: ReturnType<typeof Fastify>) {
  for (;;) {
    try {
      await bot.start({
        onStart: async (botInfo) => {
          await bot.api.setMyCommands([
            { command: "brief", description: "Bugün, yarın, önemli takvim ve mail özeti" },
            { command: "calendar", description: "Yaklaşan takvim etkinlikleri" },
            { command: "mail", description: "Önemli mailleri listele veya bir maili aç" },
            { command: "memory", description: "Perskop hafızasını incele" },
            { command: "remember", description: "Tüm ajanlara kalıcı bilgi öğret" },
            { command: "status", description: "Gateway ve motor durumu" },
            { command: "tasks", description: "Son Perskop görevlerini gör" },
            { command: "sessions", description: "Mac oturumlarını telefondan gör" },
            { command: "session", description: "Mac oturumunun son mesajlarını oku" },
            { command: "open", description: "Mac'te bir oturumu aç" },
            { command: "newsession", description: "Mac'te yeni oturum aç" },
          ]);
          app.log.info({ username: botInfo.username }, "Telegram polling active");
        },
      });
      app.log.warn("Telegram polling stopped; restarting");
    } catch (err) {
      app.log.error({ err }, "Telegram polling failed; restarting");
    }
    await new Promise((resolve) => setTimeout(resolve, TELEGRAM_RESTART_DELAY_MS));
  }
}

async function main() {
  const config = loadConfig();
  const memory = new MemoryStore(config.DATA_DIR);

  const app = Fastify({ logger: true });

  await registerApiRoutes(app, config, memory);

  const publicDir = path.join(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });

  if (config.TELEGRAM_BOT_TOKEN) {
    const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    registerTelegramHandlers(bot, config, memory);
    bot.catch(async (err) => {
      app.log.error(
        {
          err: err.error,
          updateId: err.ctx.update.update_id,
        },
        "Telegram update handler failed",
      );
      try {
        await err.ctx.reply("Bu mesaj işlenirken hata oluştu. Tekrar deneyebilirsin.");
      } catch {
        // The original failure may also affect replies; keep polling regardless.
      }
    });
    void keepTelegramPolling(bot, app);
    startEmailSyncScheduler(config, memory, {
      onTrackedMail: async (message, body) => {
        const chatId = config.TELEGRAM_NOTIFY_CHAT_ID;
        if (!chatId) throw new Error("TELEGRAM_NOTIFY_CHAT_ID not set");
        await bot.api.sendMessage(chatId, formatTrackedMailAlert(message, body));
        app.log.info({ uid: message.uid, from: message.from }, "tracked mail alert sent");
      },
    });
    startCronScheduler({ config, memory, bot, log: app.log });
  } else {
    app.log.warn("TELEGRAM_BOT_TOKEN not set — Telegram disabled");
    startEmailSyncScheduler(config, memory);
    startCronScheduler({ config, memory, log: app.log });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  startGmailBackgroundSyncScheduler(config, app.log);
  app.log.info(`perskop gateway listening on ${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
