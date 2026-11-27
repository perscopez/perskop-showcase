export type ProviderFailureKind =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "transport"
  | "malformed_response"
  | "provider_unavailable"
  | "unknown";

export type NormalizedProviderFailure = {
  kind: ProviderFailureKind;
  retryable: boolean;
  message: string;
  statusCode?: number;
  exitCode?: number;
  causeCode?: string;
  cooldownUntil?: string;
};

export type ProviderFailureInput = {
  message?: string;
  name?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  exitCode?: number;
  retryAfter?: string | number;
  retryAfterMs?: number;
  headers?: Headers | Record<string, string | undefined>;
};
