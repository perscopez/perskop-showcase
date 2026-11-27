import type { MemoryRow } from "../db.js";
import { redactConversationSecrets } from "../memory/conversation.js";

export function rememberText(commandText: string): string {
  return redactConversationSecrets(commandText.replace(/^\/remember(?:@\w+)?\s*/i, "").trim()).slice(0, 4_000);
}

export function memoryQuery(commandText: string): string {
  return commandText.replace(/^\/memory(?:@\w+)?\s*/i, "").trim().slice(0, 300);
}

export function formatMemoryList(items: MemoryRow[]): string {
  if (!items.length) return "Bu kapsamda kayıtlı hafıza yok.";
  const lines = items.slice(0, 8).map((item, index) => {
    const date = new Date(item.created_at).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
    return `${index + 1}. ${item.title} · ${item.memory_type} · ${date}`;
  });
  return ["🧠 Perskop hafızası", ...lines, "", "Yeni bilgi: /remember kısa ve kalıcı bilgi"].join("\n");
}
