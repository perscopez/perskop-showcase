function taskIcon(status: string): string {
  if (["done", "succeeded"].includes(status)) return "✅";
  if (["waiting_for_node"].includes(status)) return "💻";
  if (["waiting_approval"].includes(status)) return "🛂";
  if (["running", "pending", "queued"].includes(status)) return "⏳";
  if (["cancelled", "rejected"].includes(status)) return "⛔️";
  return "❌";
}

export function formatTaskList(items: Array<Record<string, any>>): string {
  if (items.length === 0) return "Henüz görev yok.";
  const lines = items.slice(0, 8).map((item) => {
    const prompt = String(item.prompt || "İsimsiz görev").replace(/\s+/g, " ").slice(0, 90);
    const engine = item.provider || item.engine;
    const target = item.target_node_id ? ` · →${item.target_node_id}` : "";
    return `${taskIcon(String(item.status))} #${item.id} · ${item.status}${engine ? ` · ${engine}` : ""}${target}\n${prompt}`;
  });
  return `Son görevler:\n\n${lines.join("\n\n")}\n\nİptal: /cancel <görev-id>`;
}

export function formatTaskDetail(item: Record<string, any> | null | undefined): string {
  if (!item) return "Görev bulunamadı.";
  const prompt = String(item.prompt || "İsimsiz görev").replace(/\s+/g, " ").slice(0, 240);
  const lines = [
    `${taskIcon(String(item.status))} Görev #${item.id}`,
    `Durum: ${item.status}`,
    item.provider || item.engine ? `Motor: ${item.provider || item.engine}` : null,
    item.target_node_id ? `Hedef: ${item.target_node_id}` : null,
    item.parent_session_id ? `Oturum: ${String(item.parent_session_id).slice(-8)}` : null,
    item.error ? `Hata: ${String(item.error).slice(0, 200)}` : null,
    "",
    prompt,
  ].filter((line) => line !== null);
  return lines.join("\n");
}

export function formatNodeList(items: Array<Record<string, any>>, nowMs = Date.now()): string {
  if (items.length === 0) return "Kayıtlı Mac node yok. Perskop Mac uygulaması açılınca burada görünür.";
  const lines = items.slice(0, 8).map((item) => {
    const lease = Date.parse(String(item.onlineLeaseUntil || item.online_lease_until || ""));
    const online = item.online === true || item.online === 1 || (Number.isFinite(lease) && lease > nowMs);
    const marker = item.revokedAt || item.revoked_at ? "🚫" : (online ? "🟢" : "⚫️");
    const load = item.currentLoad ?? item.current_load ?? 0;
    const sessions = item.sessionCount ?? item.session_count ?? 0;
    return `${marker} ${item.displayName || item.display_name || item.id}\n   yük ${load} · oturum ${sessions}${online ? "" : " · çevrimdışı"}`;
  });
  return `Mac node'ları:\n\n${lines.join("\n\n")}`;
}
