export function formatRemoteSessions(items: Array<Record<string, any>>, nowMs = Date.now()): string {
  if (items.length === 0) {
    return "Mac oturumu görünmüyor. Perskop Mac uygulaması açıkken birkaç saniye içinde burada belirir.";
  }
  const lines = items.slice(0, 12).map((item, index) => {
    const seenMs = Date.parse(String(item.last_seen_at || ""));
    const online = Number.isFinite(seenMs) && nowMs - seenMs < 60_000;
    const marker = online ? "🟢" : "⚫️";
    const active = Number(item.is_active) ? " · çalışıyor" : "";
    const title = String(item.title || item.preview || "İsimsiz oturum").replace(/\s+/g, " ").slice(0, 80);
    return `${index + 1}. ${marker} ${title}${active}\n   /open ${String(item.session_id).slice(-8)}`;
  });
  return `Mac oturumları:\n\n${lines.join("\n\n")}\n\nYeni pencere: /newsession`;
}

export function remoteSessionPrefix(text: string): string {
  return text.replace(/^\/open(?:@[a-zA-Z0-9_]+)?\s*/i, "").trim();
}

export function remoteSessionPrompt(text: string): { selector: string; prompt: string } | null {
  const body = text.replace(/^\/send(?:@[a-zA-Z0-9_]+)?\s*/i, "").trim();
  const separator = body.search(/\s/);
  if (separator <= 0) return null;
  const selector = body.slice(0, separator).trim();
  const prompt = body.slice(separator).trim();
  return selector && prompt ? { selector, prompt } : null;
}
