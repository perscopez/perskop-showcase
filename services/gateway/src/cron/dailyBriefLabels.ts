import type { AppConfig } from "../config.js";
import { callDirectModelStreaming } from "../providers/directModel.js";
import { fallbackMailPurpose, type DailyMailGroup } from "./dailyBrief.js";

type ModelCall = (config: AppConfig, prompt: string, options: { signal?: AbortSignal }) => Promise<string>;

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 60 && value.trim().split(/\s+/).length <= 8;
}

function parseLabels(raw: string, allowedIds: Set<string>): Map<string, string> {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return new Map();
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return new Map();
    const labels = new Map<string, string>();
    for (const item of parsed) {
      const id = String(item?.id ?? "");
      if (allowedIds.has(id) && validLabel(item?.label)) labels.set(id, item.label.trim());
    }
    return labels;
  } catch {
    return new Map();
  }
}

export async function labelDailyMailGroups(
  config: AppConfig,
  groups: DailyMailGroup[],
  deps: { callModel?: ModelCall; timeoutMs?: number } = {},
): Promise<Map<string, string>> {
  const fallback = new Map(groups.map((group) => [String(group.message.uid), fallbackMailPurpose(group.message)]));
  if (!groups.length) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  const callModel = deps.callModel ?? ((cfg, prompt, options) => callDirectModelStreaming(cfg, prompt, undefined, options));
  const items = groups.map((group) => ({ id: String(group.message.uid), sender: group.message.from.slice(0, 160), subject: group.message.subject.slice(0, 240) }));
  const prompt = [
    "Her mail için Türkçe, açık, 2-6 kelimelik amaç etiketi üret.",
    "Yalnız JSON dizi döndür: [{\"id\":\"...\",\"label\":\"...\"}]. Açıklama yazma.",
    `Mailler: ${JSON.stringify(items)}`,
  ].join("\n");
  try {
    const parsed = parseLabels(await callModel(config, prompt, { signal: controller.signal }), new Set(items.map((item) => item.id)));
    for (const [id, label] of parsed) fallback.set(id, label);
  } catch {
    // Deterministic labels keep the brief useful when the free model is unavailable.
  } finally {
    clearTimeout(timer);
  }
  return fallback;
}
