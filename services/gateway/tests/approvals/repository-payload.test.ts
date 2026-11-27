import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalRepositoryApproval,
  equalApprovalHash,
  hashCanonicalApproval,
  repositoryOperationSchema,
} from "../../src/security/repositoryApproval.js";

const baseOperation = {
  schemaVersion: 1 as const,
  repositoryId: "perskop",
  workingDirectory: "workspace",
  baseCommit: "a".repeat(40),
  allowedPaths: ["README.md", "src/index.ts"],
  patch: "diff --git a/README.md b/README.md\n+approved\n",
  expectedChangedPaths: ["README.md"],
  engine: "codex" as const,
  timeoutSeconds: 300,
  verificationCommand: ["npm", "test"],
  expectedExitCode: 0,
};

function hash(operation: typeof baseOperation) {
  return hashCanonicalApproval(canonicalRepositoryApproval({ taskId: 42, nonce: "nonce-1", operation }));
}

test("nested JSON ordering canonicalizes to the same approval hash", () => {
  const reordered = {
    timeoutSeconds: 300,
    verificationCommand: ["npm", "test"],
    expectedExitCode: 0,
    engine: "codex" as const,
    expectedChangedPaths: ["README.md"],
    patch: baseOperation.patch,
    allowedPaths: ["README.md", "src/index.ts"],
    baseCommit: baseOperation.baseCommit,
    workingDirectory: "workspace",
    repositoryId: "perskop",
    schemaVersion: 1 as const,
  };
  assert.equal(hash(baseOperation), hash(reordered));
});

test("every approval-bound field mutation is rejected", () => {
  const approved = hash(baseOperation);
  const mutations = [
    { ...baseOperation, repositoryId: "other" },
    { ...baseOperation, workingDirectory: "other" },
    { ...baseOperation, baseCommit: "b".repeat(40) },
    { ...baseOperation, allowedPaths: ["README.md"] },
    { ...baseOperation, patch: `${baseOperation.patch}+changed\n` },
    { ...baseOperation, expectedChangedPaths: ["src/index.ts"] },
    { ...baseOperation, engine: "agy" as const },
    { ...baseOperation, timeoutSeconds: 301 },
    { ...baseOperation, verificationCommand: ["npm", "run", "test:unit"] },
    { ...baseOperation, expectedExitCode: 1 },
  ];
  for (const mutation of mutations) {
    assert.equal(equalApprovalHash(approved, hash(mutation as typeof baseOperation)), false);
  }
  const nonceMutation = hashCanonicalApproval(
    canonicalRepositoryApproval({ taskId: 42, nonce: "nonce-2", operation: baseOperation }),
  );
  assert.equal(equalApprovalHash(approved, nonceMutation), false);
});

test("Unicode normalization changes are rejected rather than normalized away", () => {
  const composed = { ...baseOperation, patch: "+caf\u00e9\n" };
  const decomposed = { ...baseOperation, patch: "+cafe\u0301\n" };
  assert.equal(equalApprovalHash(hash(composed), hash(decomposed)), false);
});

test("unsafe or incomplete operation payloads are rejected", () => {
  const invalid = [
    { ...baseOperation, baseCommit: "" },
    { ...baseOperation, allowedPaths: ["*"] },
    { ...baseOperation, allowedPaths: ["../secret"] },
    { ...baseOperation, expectedChangedPaths: ["not-allowed.txt"] },
    { ...baseOperation, workingDirectory: "/root" },
    { ...baseOperation, expectedDiffHash: "any" },
    { ...baseOperation, patchHash: "any" },
    { ...baseOperation, shell: "rm -rf /" },
    { ...baseOperation, verificationCommand: [] },
    { ...baseOperation, expectedExitCode: -1 },
  ];
  for (const value of invalid) assert.equal(repositoryOperationSchema.safeParse(value).success, false);
});
