export function redactConversationSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{25,}\b/g, "[REDACTED]")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/gi, "[REDACTED]");
}

export function conversationMemoryContent(input: { prompt: string; response: string; provider: string }): string {
  const prompt = redactConversationSecrets(input.prompt).slice(0, 4_000);
  const response = redactConversationSecrets(input.response).slice(0, 8_000);
  return [`User request:\n${prompt}`, `Agent response (${input.provider}):\n${response}`].join("\n\n");
}
