import crypto from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../utils/jcs.js";

const safeRelativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "path must be repository-relative")
  .refine((value) => !/[?*\[\]{}]/.test(value), "wildcard paths are not allowed")
  .refine((value) => !value.includes("\\"), "backslash paths are not allowed");

export const repositoryOperationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    repositoryId: z.string().min(1).max(256).refine((value) => !/[?*]/.test(value), "wildcards are not allowed"),
    workingDirectory: safeRelativePath,
    baseCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/i, "baseCommit must be a full Git object ID"),
    allowedPaths: z.array(safeRelativePath).min(1).max(100),
    patch: z.string().min(1).max(2_000_000),
    expectedChangedPaths: z.array(safeRelativePath).min(1).max(100),
    engine: z.enum(["codex", "cursor", "opencode", "agy"]),
    timeoutSeconds: z.number().int().min(1).max(900),
    verificationCommand: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(32),
    expectedExitCode: z.number().int().min(0).max(255),
  })
  .strict()
  .superRefine((operation, context) => {
    const allowed = new Set(operation.allowedPaths);
    for (const changedPath of operation.expectedChangedPaths) {
      if (!allowed.has(changedPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedChangedPaths"],
          message: `expected changed path is not allowed: ${changedPath}`,
        });
      }
    }
  });

export type RepositoryOperation = z.infer<typeof repositoryOperationSchema>;

export function buildRepositoryApprovalPayload(input: {
  taskId: number;
  nonce: string;
  operation: RepositoryOperation;
}) {
  const operation = repositoryOperationSchema.parse(input.operation);
  return {
    schemaVersion: operation.schemaVersion,
    operationType: "repository_write" as const,
    taskId: input.taskId,
    repositoryId: operation.repositoryId,
    workingDirectory: operation.workingDirectory,
    baseCommit: operation.baseCommit,
    allowedPaths: operation.allowedPaths,
    patchHash: crypto.createHash("sha256").update(operation.patch, "utf8").digest("hex"),
    expectedChangedPaths: operation.expectedChangedPaths,
    engine: operation.engine,
    timeoutSeconds: operation.timeoutSeconds,
    verificationCommand: operation.verificationCommand,
    expectedExitCode: operation.expectedExitCode,
    nonce: input.nonce,
  };
}

export function canonicalRepositoryApproval(input: {
  taskId: number;
  nonce: string;
  operation: RepositoryOperation;
}): string {
  return canonicalize(buildRepositoryApprovalPayload(input));
}

export function hashCanonicalApproval(canonicalPayload: string): string {
  return crypto
    .createHash("sha256")
    .update("perskop-approval-v1\0", "utf8")
    .update(canonicalPayload, "utf8")
    .digest("hex");
}

export function equalApprovalHash(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
