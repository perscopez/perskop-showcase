import type {
  NormalizedProviderFailure,
  ProviderFailureInput,
  ProviderFailureKind,
} from "./types.js";

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
]);

function asInput(error: unknown): ProviderFailureInput {
  if (error instanceof Error) {
    return error as Error & ProviderFailureInput;
  }
  if (error && typeof error === "object") {
    return error as ProviderFailureInput;
  }
  return { message: String(error) };
}

function headerValue(
  headers: ProviderFailureInput["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
}

function retryAt(input: ProviderFailureInput, nowMs: number): string | undefined {
  if (Number.isFinite(input.retryAfterMs) && Number(input.retryAfterMs) >= 0) {
    return new Date(nowMs + Number(input.retryAfterMs)).toISOString();
  }

  const raw = input.retryAfter ?? headerValue(input.headers, "retry-after");
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number" || /^\d+(?:\.\d+)?$/.test(String(raw).trim())) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return new Date(nowMs + seconds * 1000).toISOString();
  }

  const parsed = Date.parse(String(raw));
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(Math.max(nowMs, parsed)).toISOString();
}

export function redactProviderMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;"']+/gi, "$1=[REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]{20,}(?:\.[a-zA-Z0-9_-]+){1,2}\b/g, "[REDACTED_TOKEN]")
    .slice(0, 2000);
}

function classify(input: ProviderFailureInput, message: string): ProviderFailureKind {
  const statusCode = input.statusCode ?? input.status;
  const code = String(input.code ?? "").toUpperCase();
  const lower = message.toLowerCase();

  if (
    statusCode === 429 ||
    /rate[ -]?limit|too many requests|quota (?:exceeded|reached)|code["': ]+1302/.test(lower)
  ) {
    return "rate_limit";
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthori[sz]ed|forbidden|invalid (?:api[_ -]?key|credential|auth)|authentication failed|access token expired/.test(lower)
  ) {
    return "auth";
  }
  if (
    input.name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    /timed? out|timeout/.test(lower)
  ) {
    return "timeout";
  }
  if (
    /malformed sse|invalid (?:sse|json)|stream ended before \[done\]|stream disconnected before completion/.test(lower)
  ) {
    return "malformed_response";
  }
  if (
    TRANSPORT_CODES.has(code) ||
    /failed to fetch|network (?:error|failure)|websocket.*failed|dns|enotfound|econnreset/.test(lower)
  ) {
    return "transport";
  }
  if (
    input.exitCode === 126 ||
    input.exitCode === 127 ||
    code === "ENOENT" ||
    /command not found|cli bulunamadı/.test(lower)
  ) {
    return "provider_unavailable";
  }
  return "unknown";
}

export function normalizeProviderFailure(
  error: unknown,
  nowMs = Date.now(),
): NormalizedProviderFailure {
  const input = asInput(error);
  const rawMessage = input.message || (error instanceof Error ? error.message : String(error));
  const message = redactProviderMessage(rawMessage || "Unknown provider failure");
  const kind = classify(input, message);
  const statusCode = input.statusCode ?? input.status;
  const causeCode = input.code === undefined ? undefined : String(input.code);

  return {
    kind,
    retryable: ["rate_limit", "timeout", "transport", "malformed_response"].includes(kind),
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(kind !== "rate_limit" ? {} : { cooldownUntil: retryAt(input, nowMs) }),
  };
}
