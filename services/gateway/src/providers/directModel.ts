import type { AppConfig } from "../config.js";
import { normalizeProviderFailure } from "./errors.js";
import type { NormalizedProviderFailure } from "./types.js";

export type DirectModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type DirectModelResult = {
  output: string;
  requestedModel: string;
  returnedModel?: string;
  usage?: DirectModelUsage;
};

export class DirectModelError extends Error {
  readonly failure: NormalizedProviderFailure;
  readonly statusCode?: number;
  readonly retryAfter?: string | number;

  constructor(error: unknown, nowMs = Date.now()) {
    const failure = normalizeProviderFailure(error, nowMs);
    super(failure.message, { cause: error });
    this.name = "DirectModelError";
    this.failure = failure;
    this.statusCode = failure.statusCode;
    if (error && typeof error === "object" && "retryAfter" in error) {
      this.retryAfter = (error as { retryAfter?: string | number }).retryAfter;
    }
  }
}

function usageFrom(value: any): DirectModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage: DirectModelUsage = {
    promptTokens: typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined,
    completionTokens: typeof value.completion_tokens === "number" ? value.completion_tokens : undefined,
    totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : undefined,
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

export async function callDirectModel(
  config: AppConfig,
  prompt: string,
  onToken?: (token: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<DirectModelResult> {
  const proxyUrl = config.PERSKOP_LLM_PROXY_URL;
  const proxySecret = config.PERSKOP_LLM_PROXY_SECRET;
  if (!proxyUrl || !proxySecret) {
    throw new Error("direct_model requires PERSKOP_LLM_PROXY_URL and PERSKOP_LLM_PROXY_SECRET");
  }
  const requestedModel = "glm-4.7-flash";
  const timeoutMs = config.PERSKOP_LLM_TIMEOUT_MS ?? 60_000;
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const abortFromCaller = () => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    if (cancelled) throw new DOMException("Model request cancelled", "AbortError");
    const response = await fetch(`${proxyUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxySecret}`,
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw Object.assign(new Error(`Model API returned status ${response.status}: ${errorText}`), {
        statusCode: response.status,
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let returnedModel: string | undefined;
    let usage: DirectModelUsage | undefined;
    let sawDone = false;

    const parseLine = async (rawLine: string): Promise<void> => {
      const line = rawLine.trim();
      if (!line) return;
      if (line === "data: [DONE]" || line === "data:[DONE]") {
        sawDone = true;
        await reader.cancel();
        return;
      }
      if (!line.startsWith("data:")) return;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (typeof parsed.model === "string") returnedModel = parsed.model;
        usage = usageFrom(parsed.usage) ?? usage;
        const token = parsed.choices?.[0]?.delta?.content;
        if (typeof token === "string" && token) {
          output += token;
          onToken?.(token);
        }
      } catch (error) {
        throw new Error(`Malformed SSE payload from model proxy: ${String(error)}`);
      }
    };

    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await parseLine(line);
        if (sawDone) break;
      }
    }
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) await parseLine(buffer);
    if (!sawDone) throw new Error("Model proxy stream ended before [DONE]");

    return { output, requestedModel, returnedModel, usage };
  } catch (error) {
    if (error instanceof DirectModelError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      if (cancelled && !timedOut) throw new Error("Model API request cancelled");
      const timeoutError = Object.assign(new Error(`Model API request timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
      throw new DirectModelError(timeoutError);
    }
    throw new DirectModelError(error);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function callDirectModelStreaming(
  config: AppConfig,
  prompt: string,
  onToken?: (token: string) => void,
  options?: { signal?: AbortSignal },
): Promise<string> {
  return (await callDirectModel(config, prompt, onToken, options)).output;
}
