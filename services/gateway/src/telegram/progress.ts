type ProgressContext = {
  replyWithChatAction: (action: "typing") => Promise<unknown>;
  reply: (text: string) => Promise<unknown>;
};

export async function withTelegramProgress<T>(
  context: ProgressContext,
  task: () => Promise<T>,
  options: { typingIntervalMs?: number; noticeDelayMs?: number } = {},
): Promise<T> {
  const typing = () => context.replyWithChatAction("typing").catch(() => undefined);
  await typing();
  const interval = setInterval(() => void typing(), options.typingIntervalMs ?? 4_000);
  const notice = setTimeout(() => {
    void context.reply("Üzerinde çalışıyorum; hazır olunca sonucu buraya yazacağım.").catch(() => undefined);
  }, options.noticeDelayMs ?? 12_000);
  try {
    return await task();
  } finally {
    clearInterval(interval);
    clearTimeout(notice);
  }
}
