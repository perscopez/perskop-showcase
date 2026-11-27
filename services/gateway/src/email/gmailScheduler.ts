import type { AppConfig } from "../config.js";

type Logger = {
  info: (object: unknown, message?: string) => void;
  warn: (object: unknown, message?: string) => void;
};

type OAuthStatus = {
  accounts?: Array<{ id: string; status: string }>;
};

export async function runGmailBackgroundSync(input: {
  baseUrl: string;
  apiToken: string;
  fetch?: typeof fetch;
  maxThreads?: number;
}): Promise<Array<{ accountId: string; ok: boolean; mode?: string; threadCount?: number; error?: string }>> {
  const request = input.fetch ?? fetch;
  const headers = { authorization: `Bearer ${input.apiToken}` };
  const statusResponse = await request(`${input.baseUrl}/api/mail/connectors/google/oauth/status`, { headers });
  if (!statusResponse.ok) throw new Error(`gmail_status_${statusResponse.status}`);
  const status = await statusResponse.json() as OAuthStatus;
  const accounts = (status.accounts ?? []).filter((account) => account.status === "connected");
  const results = [];
  for (const account of accounts) {
    try {
      const response = await request(`${input.baseUrl}/api/mail/accounts/${encodeURIComponent(account.id)}/sync`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ maxThreads: input.maxThreads ?? 200 }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        const error = typeof payload?.error === "string" && /^[a-z0-9_]+$/.test(payload.error)
          ? payload.error
          : `gmail_sync_${response.status}`;
        results.push({ accountId: account.id, ok: false, error });
        continue;
      }
      const payload = await response.json() as { sync?: { mode?: string; threadCount?: number } };
      results.push({ accountId: account.id, ok: true, mode: payload.sync?.mode, threadCount: payload.sync?.threadCount });
    } catch (error) {
      results.push({ accountId: account.id, ok: false, error: error instanceof Error ? error.message : "gmail_sync_failed" });
    }
  }
  return results;
}

export function startGmailBackgroundSyncScheduler(
  config: AppConfig,
  log: Logger,
  options: { intervalMs?: number; initialDelayMs?: number; fetch?: typeof fetch } = {},
): () => void {
  const baseUrl = `http://127.0.0.1:${config.PORT}`;
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const results = await runGmailBackgroundSync({ baseUrl, apiToken: config.PERSKOP_API_TOKEN, fetch: options.fetch });
      for (const result of results) {
        if (result.ok) log.info(result, "Gmail background sync completed");
        else log.warn(result, "Gmail background sync failed");
      }
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, "Gmail background sync discovery failed");
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void run(), options.initialDelayMs ?? 15_000);
  const interval = setInterval(() => void run(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
