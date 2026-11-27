import { normalizeProviderFailure } from "./errors.js";
import type {
  ProviderRuntimeStateRepository,
  ProviderRuntimeStateRow,
} from "./runtimeState.js";
import type { NormalizedProviderFailure } from "./types.js";

export type ProviderCapability =
  | "conversation"
  | "factual"
  | "repository_read"
  | "repository_write";

export type PolicyRisk = "low" | "high";

export type PolicyProviderAdapter<Name extends string = string, Value = unknown> = {
  name: Name;
  capabilities: readonly ProviderCapability[];
  highRiskEligible: boolean;
  execute: () => Promise<Value>;
};

export type PolicyDiagnosticReason =
  | "capability_mismatch"
  | "cooldown"
  | "unavailable"
  | "high_risk_ineligible"
  | "not_registered";

export type PolicySelection<Name extends string = string> = {
  attempts: Array<{
    provider: Name;
    reason: "manual_pin" | "preferred" | "fallback";
    fallbackAllowed: boolean;
  }>;
  diagnostics: Array<{
    provider: string;
    reason: PolicyDiagnosticReason;
    resetAt?: string;
  }>;
};

export type PolicyTrace<Name extends string = string> = {
  nodeId: string;
  capability: ProviderCapability;
  risk: PolicyRisk;
  selectedProvider?: Name;
  attempts: Array<{
    provider: Name;
    selectionReason: "manual_pin" | "preferred" | "fallback";
    status: "started" | "failed" | "succeeded";
    fallbackReason?: string;
    failure?: NormalizedProviderFailure;
  }>;
  diagnostics: PolicySelection<Name>["diagnostics"];
};

type RuntimeWriter = Pick<ProviderRuntimeStateRepository, "recordFailure" | "recordSuccess">;

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function selectProviderAttempts<Name extends string, Value>(input: {
  adapters: readonly PolicyProviderAdapter<Name, Value>[];
  nodeId: string;
  capability: ProviderCapability;
  risk: PolicyRisk;
  preference: readonly Name[];
  pinnedProvider?: Name;
  runtimeState?: readonly ProviderRuntimeStateRow[];
  maxAttempts?: number;
  nowMs?: number;
}): PolicySelection<Name> {
  const adaptersByName = new Map(input.adapters.map((adapter) => [adapter.name, adapter]));
  const stateByName = new Map(
    (input.runtimeState ?? [])
      .filter((row) => row.node_id === input.nodeId && row.capability === input.capability)
      .map((row) => [row.provider, row]),
  );
  const runtimePin = (input.runtimeState ?? []).find(
    (row) => row.node_id === input.nodeId && row.capability === input.capability && row.manual_pin === 1,
  )?.provider as Name | undefined;
  const pin = input.pinnedProvider ?? runtimePin;
  const ordered = unique([
    ...(pin ? [pin] : []),
    ...input.preference,
    ...input.adapters.map((adapter) => adapter.name),
  ]);
  const diagnostics: PolicySelection<Name>["diagnostics"] = [];
  const eligible: Name[] = [];
  const now = input.nowMs ?? Date.now();

  for (const provider of ordered) {
    const adapter = adaptersByName.get(provider);
    if (!adapter) {
      diagnostics.push({ provider, reason: "not_registered" });
      continue;
    }
    if (!adapter.capabilities.includes(input.capability)) {
      diagnostics.push({ provider, reason: "capability_mismatch" });
      continue;
    }
    if (input.risk === "high" && !adapter.highRiskEligible) {
      diagnostics.push({ provider, reason: "high_risk_ineligible" });
      continue;
    }
    const state = stateByName.get(provider);
    if (state?.status === "unavailable") {
      diagnostics.push({ provider, reason: "unavailable" });
      continue;
    }
    if (state?.status === "cooldown" && (!state.reset_at || Date.parse(state.reset_at) > now)) {
      diagnostics.push({ provider, reason: "cooldown", resetAt: state.reset_at ?? undefined });
      continue;
    }
    eligible.push(provider);
  }

  // A pin on high-risk work is an explicit trust boundary. If that provider
  // cannot run the task, do not silently downgrade to another executor.
  const candidates = input.risk === "high" && pin
    ? eligible.filter((provider) => provider === pin)
    : eligible;
  const requestedMax = Math.max(1, input.maxAttempts ?? 2);
  const limit = input.risk === "high" ? 1 : requestedMax;
  const selected = candidates.slice(0, limit);

  return {
    attempts: selected.map((provider, index) => ({
      provider,
      reason: provider === pin ? "manual_pin" : index === 0 ? "preferred" : "fallback",
      fallbackAllowed: input.risk === "low" && index < selected.length - 1,
    })),
    diagnostics,
  };
}

export async function executeProviderPolicy<Name extends string, Value>(input: {
  adapters: readonly PolicyProviderAdapter<Name, Value>[];
  nodeId: string;
  capability: ProviderCapability;
  risk: PolicyRisk;
  preference: readonly Name[];
  pinnedProvider?: Name;
  runtimeState?: readonly ProviderRuntimeStateRow[];
  maxAttempts?: number;
  nowMs?: number;
  runtime?: RuntimeWriter;
  persistTrace?: (trace: PolicyTrace<Name>) => void;
}): Promise<{ provider: Name; value: Value; trace: PolicyTrace<Name> }> {
  const selection = selectProviderAttempts(input);
  const adaptersByName = new Map(input.adapters.map((adapter) => [adapter.name, adapter]));
  const trace: PolicyTrace<Name> = {
    nodeId: input.nodeId,
    capability: input.capability,
    risk: input.risk,
    attempts: [],
    diagnostics: selection.diagnostics,
  };
  let previousFailure: { provider: Name; failure: NormalizedProviderFailure } | undefined;

  for (const attempt of selection.attempts) {
    const adapter = adaptersByName.get(attempt.provider)!;
    const traceAttempt: PolicyTrace<Name>["attempts"][number] = {
      provider: attempt.provider,
      selectionReason: attempt.reason,
      status: "started",
      ...(previousFailure
        ? { fallbackReason: `${previousFailure.provider}:${previousFailure.failure.kind}` }
        : {}),
    };
    trace.attempts.push(traceAttempt);
    input.persistTrace?.(structuredClone(trace));
    const startedAt = Date.now();
    try {
      const value = await adapter.execute();
      traceAttempt.status = "succeeded";
      trace.selectedProvider = attempt.provider;
      input.runtime?.recordSuccess({
        provider: attempt.provider,
        nodeId: input.nodeId,
        capability: input.capability,
        latencyMs: Date.now() - startedAt,
        nowMs: input.nowMs,
      });
      input.persistTrace?.(structuredClone(trace));
      return { provider: attempt.provider, value, trace };
    } catch (error) {
      const failure = normalizeProviderFailure(error, input.nowMs ?? Date.now());
      traceAttempt.status = "failed";
      traceAttempt.failure = failure;
      previousFailure = { provider: attempt.provider, failure };
      input.runtime?.recordFailure({
        provider: attempt.provider,
        nodeId: input.nodeId,
        capability: input.capability,
        failure,
        nowMs: input.nowMs,
      });
      input.persistTrace?.(structuredClone(trace));
    }
  }

  const attempted = trace.attempts.map((attempt) => attempt.provider).join(", ") || "none";
  throw Object.assign(
    new Error(`All compatible providers are unavailable; attempted: ${attempted}`),
    { code: "ALL_PROVIDERS_UNAVAILABLE", diagnostics: trace },
  );
}

export const MAC_PROVIDER_PREFERENCE = ["cursor", "codex", "agy", "opencode"] as const;
export const VPS_PROVIDER_PREFERENCE = ["direct_model", "codex", "agy", "opencode", "cursor"] as const;
