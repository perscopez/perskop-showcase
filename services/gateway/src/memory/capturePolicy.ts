export type CaptureKind = "explicit_remember" | "decision" | "preference" | "task_summary" | "failure_evidence" | "transient";

export type CaptureDecision = {
  capture: boolean;
  kind: CaptureKind;
  memoryType: string;
  confidence: number;
  expiryDays: number | null;
  dedupeKey: string | null;
  reason: string;
};

const EXPLICIT_RE = /\b(remember|hatırla|kaydet|note this|don't forget|unutma)\b/i;
const DECISION_RE = /\b(decided|karar|we will|going with|tercih ettik|use .+ instead)\b/i;
const PREFERENCE_RE = /\b(prefer|tercih|always|never|her zaman|asla)\b/i;
const SECRET_RE = /(api[_-]?key|secret|token|password|bearer\s+[a-z0-9._-]+)/i;

export function decideCapture(input: {
  text: string;
  explicit?: boolean;
  taskStatus?: string | null;
  taskId?: number | null;
  projectId?: string;
}): CaptureDecision {
  const text = String(input.text || "").trim();
  if (!text) {
    return { capture: false, kind: "transient", memoryType: "note", confidence: 0, expiryDays: null, dedupeKey: null, reason: "empty" };
  }
  if (SECRET_RE.test(text)) {
    return { capture: false, kind: "transient", memoryType: "note", confidence: 0, expiryDays: null, dedupeKey: null, reason: "secret_like" };
  }

  const projectId = input.projectId || "global";
  if (input.explicit || EXPLICIT_RE.test(text)) {
    return {
      capture: true,
      kind: "explicit_remember",
      memoryType: "note",
      confidence: 0.95,
      expiryDays: null,
      dedupeKey: `${projectId}:explicit:${hashish(text)}`,
      reason: "explicit_remember",
    };
  }

  if (input.taskStatus === "succeeded" || input.taskStatus === "done") {
    return {
      capture: true,
      kind: "task_summary",
      memoryType: "task_summary",
      confidence: 0.8,
      expiryDays: 90,
      dedupeKey: input.taskId ? `${projectId}:task:${input.taskId}:summary` : `${projectId}:task_summary:${hashish(text)}`,
      reason: "verified_task_summary",
    };
  }

  if (input.taskStatus === "failed" || input.taskStatus === "error" || input.taskStatus === "timed_out") {
    return {
      capture: true,
      kind: "failure_evidence",
      memoryType: "failure_evidence",
      confidence: 0.75,
      expiryDays: 30,
      dedupeKey: input.taskId ? `${projectId}:task:${input.taskId}:failure` : `${projectId}:failure:${hashish(text)}`,
      reason: "failure_evidence",
    };
  }

  if (DECISION_RE.test(text)) {
    return {
      capture: true,
      kind: "decision",
      memoryType: "decision",
      confidence: 0.85,
      expiryDays: null,
      dedupeKey: `${projectId}:decision:${hashish(text)}`,
      reason: "durable_decision",
    };
  }

  if (PREFERENCE_RE.test(text)) {
    return {
      capture: true,
      kind: "preference",
      memoryType: "preference",
      confidence: 0.8,
      expiryDays: null,
      dedupeKey: `${projectId}:preference:${hashish(text)}`,
      reason: "durable_preference",
    };
  }

  return {
    capture: false,
    kind: "transient",
    memoryType: "note",
    confidence: 0.2,
    expiryDays: 7,
    dedupeKey: null,
    reason: "transient_chatter",
  };
}

function hashish(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  let h = 0;
  for (let i = 0; i < normalized.length; i += 1) h = (h * 31 + normalized.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
