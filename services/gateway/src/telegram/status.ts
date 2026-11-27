export type BotStatusSnapshot = {
  diskPct?: number;
  diskFreeGb?: number;
  gmailConnected: number;
  gmailLastSync?: string | null;
  imapLastSync?: string | null;
  memoryCount: number;
  macOnline?: boolean;
  macSessionCount?: number;
  macLastSeen?: string | null;
  providers: Array<{ provider: string; status: string; error?: string | null }>;
};

function providerIcon(status: string): string {
  if (status === "healthy") return "🟢";
  if (status === "cooldown") return "🟡";
  if (status === "unavailable") return "🔴";
  return "⚪️";
}

export function formatBotStatus(snapshot: BotStatusSnapshot): string {
  const providerLines = snapshot.providers.length
    ? snapshot.providers.map((item) => `${providerIcon(item.status)} ${item.provider}: ${item.status}${item.error ? ` (${item.error})` : ""}`).join("\n")
    : "⚪️ Henüz motor sağlık verisi yok";
  const disk = snapshot.diskPct == null ? "bilinmiyor" : `%${snapshot.diskPct} dolu · ${snapshot.diskFreeGb?.toFixed(1)} GB boş`;
  const gmail = snapshot.gmailConnected
    ? `${snapshot.gmailConnected} hesap · son sync ${snapshot.gmailLastSync ? new Date(snapshot.gmailLastSync).toLocaleString("tr-TR") : "bekliyor"}`
    : "bağlı hesap yok";
  return [
    "🧭 Perskop durum",
    `Disk: ${disk}`,
    `Gmail API: ${gmail}`,
    `IMAP: ${snapshot.imapLastSync ? new Date(snapshot.imapLastSync).toLocaleString("tr-TR") : "sync yok"}`,
    `Hafıza: ${snapshot.memoryCount} kayıt`,
    `Mac: ${snapshot.macOnline ? `çevrimiçi · ${snapshot.macSessionCount ?? 0} oturum` : `çevrimdışı${snapshot.macLastSeen ? ` · son görülme ${new Date(snapshot.macLastSeen).toLocaleString("tr-TR")}` : ""}`}`,
    "",
    "Motorlar",
    providerLines,
  ].join("\n");
}
