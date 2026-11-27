type RemoteCommandResult = { ok: boolean; result?: string | null; error?: string | null };

const completed = new Map<string, { value: RemoteCommandResult; expiresAt: number }>();
const waiters = new Map<string, Set<(value: RemoteCommandResult) => void>>();
const promptPayloads = new Map<string, { prompt: string; expiresAt: number }>();

function prunePromptPayloads(nowMs = Date.now()): void {
  for (const [key, item] of promptPayloads) {
    if (item.expiresAt <= nowMs) promptPayloads.delete(key);
  }
}

export function putRemotePromptPayload(
  id: string,
  prompt: string,
  ttlMs = 5 * 60_000,
  nowMs = Date.now(),
): void {
  prunePromptPayloads(nowMs);
  promptPayloads.set(id, { prompt, expiresAt: nowMs + ttlMs });
}

export function getRemotePromptPayload(id: string, nowMs = Date.now()): string | null {
  prunePromptPayloads(nowMs);
  return promptPayloads.get(id)?.prompt ?? null;
}

export function deleteRemotePromptPayload(id: string): void {
  promptPayloads.delete(id);
}

export function publishRemoteCommandResult(id: string, value: RemoteCommandResult): void {
  deleteRemotePromptPayload(id);
  completed.set(id, { value, expiresAt: Date.now() + 60_000 });
  for (const resolve of waiters.get(id) ?? []) resolve(value);
  waiters.delete(id);
  for (const [key, item] of completed) if (item.expiresAt <= Date.now()) completed.delete(key);
}

export function waitForRemoteCommandResult(id: string, timeoutMs = 25_000): Promise<RemoteCommandResult | null> {
  const cached = completed.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    completed.delete(id);
    return Promise.resolve(cached.value);
  }
  return new Promise((resolve) => {
    const finish = (value: RemoteCommandResult | null) => {
      clearTimeout(timer);
      const set = waiters.get(id);
      set?.delete(onResult);
      if (set?.size === 0) waiters.delete(id);
      completed.delete(id);
      resolve(value);
    };
    const onResult = (value: RemoteCommandResult) => finish(value);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const set = waiters.get(id) ?? new Set();
    set.add(onResult);
    waiters.set(id, set);
  });
}
