import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  PERSKOP_API_TOKEN: z.string().min(8),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  TELEGRAM_NOTIFY_CHAT_ID: z.string().optional(),
  CODEX_CMD: z.string().default("codex"),
  CURSOR_CMD: z.string().default("cursor-agent"),
  OPENCODE_CMD: z.string().default("opencode"),
  AGY_CMD: z.string().default("agy"),
  DEFAULT_PROVIDER: z
    .enum(["codex", "cursor", "opencode", "agy"])
    .default("codex"),
  EMAIL_ADDRESS: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),
  EMAIL_IMAP_HOST: z.string().default("imap.gmail.com"),
  EMAIL_IMAP_PORT: z.coerce.number().default(993),
  EMAIL_SMTP_HOST: z.string().default("smtp.gmail.com"),
  EMAIL_SMTP_PORT: z.coerce.number().default(587),
  CRON_EMAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CRON_MORNING_BRIEF: z.string().default("0 8 * * *"),
  CRON_CALENDAR_BRIEF_HOURS: z.string().default("13,22"),
  CRON_TZ: z.string().default("Europe/Istanbul"),
  PERSKOP_FULL_ACCESS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  PERSKOP_LLM_PROXY_URL: z.string().optional(),
  PERSKOP_LLM_PROXY_SECRET: z.string().optional(),
  PERSKOP_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PERSKOP_EXECUTOR_URL: z.string().optional(),
  PERSKOP_EXECUTOR_TOKEN: z.string().optional(),
  PERSKOP_CONNECTOR_MASTER_KEY: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  PERSKOP_NODE_ID: z.enum(["mac", "vps"]).optional(),
  PERSKOP_MAC_PROVIDER_ORDER: z.string().optional(),
  PERSKOP_VPS_PROVIDER_ORDER: z.string().optional(),
  PERSKOP_PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).optional(),
  VOICE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  VOICE_STT_PROVIDER: z.enum(["openai", "local"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  allowedTelegramUserIds: number[];
  PERSKOP_FULL_ACCESS: boolean;
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const allowedTelegramUserIds =
    parsed.TELEGRAM_ALLOWED_USER_IDS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)) ?? [];

  return {
    ...parsed,
    PERSKOP_FULL_ACCESS: parsed.PERSKOP_FULL_ACCESS ?? false,
    allowedTelegramUserIds,
  };
}
