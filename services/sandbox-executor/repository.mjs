import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SAFE_PATH = /^[^\\*?\[\]{}]+$/;
const ENGINES = new Set(["codex", "cursor", "opencode", "agy"]);

function assertSafeRelative(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").includes("..") ||
    !SAFE_PATH.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
}

export function validateRepositoryOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("Invalid repository operation");
  }
  if (operation.schemaVersion !== 1) throw new Error("Invalid schemaVersion");
  if (
    typeof operation.repositoryId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(operation.repositoryId)
  ) {
    throw new Error("Invalid repositoryId");
  }
  assertSafeRelative(operation.workingDirectory, "workingDirectory");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(operation.baseCommit ?? "")) {
    throw new Error("Invalid baseCommit");
  }
  for (const field of ["allowedPaths", "expectedChangedPaths"]) {
    if (
      !Array.isArray(operation[field]) ||
      operation[field].length === 0 ||
      operation[field].length > 100
    ) {
      throw new Error(`Invalid ${field}`);
    }
    for (const value of operation[field]) assertSafeRelative(value, field);
  }
  if (
    typeof operation.patch !== "string" ||
    operation.patch.length === 0 ||
    operation.patch.length > 2_000_000
  ) {
    throw new Error("Invalid patch");
  }
  const actualPatchHash = crypto
    .createHash("sha256")
    .update(operation.patch, "utf8")
    .digest("hex");
  if (
    typeof operation.patchHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(operation.patchHash) ||
    !crypto.timingSafeEqual(
      Buffer.from(actualPatchHash, "hex"),
      Buffer.from(operation.patchHash, "hex"),
    )
  ) {
    throw new Error("Approved patch hash mismatch");
  }
  if (!ENGINES.has(operation.engine)) throw new Error("Invalid engine");
  if (
    !Number.isInteger(operation.timeoutSeconds) ||
    operation.timeoutSeconds < 1 ||
    operation.timeoutSeconds > 900
  ) {
    throw new Error("Invalid timeoutSeconds");
  }
  if (
    !Array.isArray(operation.verificationCommand) ||
    operation.verificationCommand.length === 0 ||
    operation.verificationCommand.length > 32 ||
    operation.verificationCommand.some(
      (part) =>
        typeof part !== "string" || part.length === 0 || part.includes("\0"),
    )
  ) {
    throw new Error("Invalid verificationCommand");
  }
  if (
    !Number.isInteger(operation.expectedExitCode) ||
    operation.expectedExitCode < 0 ||
    operation.expectedExitCode > 255
  ) {
    throw new Error("Invalid expectedExitCode");
  }
  return operation;
}

function git(cwd, args, options = {}) {
  const safeDirectory = path.resolve(cwd);
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${safeDirectory}`, ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function repositorySource(repositoryRoot, repositoryId) {
  const root = path.resolve(repositoryRoot);
  const source = path.resolve(root, repositoryId);
  if (!source.startsWith(`${root}${path.sep}`)) {
    throw new Error("Repository escapes configured root");
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  try {
    git(source, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  return source;
}

export function prepareRepositoryWorkspace({
  operation: input,
  repositoryRoot,
  workspacePath,
}) {
  const operation = validateRepositoryOperation(input);
  const source = repositorySource(repositoryRoot, operation.repositoryId);
  git(source, ["cat-file", "-e", `${operation.baseCommit}^{commit}`]);

  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  git(path.dirname(workspacePath), [
    "clone",
    "--no-local",
    "--no-checkout",
    "--quiet",
    source,
    workspacePath,
  ]);
  git(workspacePath, ["checkout", "--detach", "--quiet", operation.baseCommit]);

  const head = git(workspacePath, ["rev-parse", "HEAD"]).trim();
  if (head.toLowerCase() !== operation.baseCommit.toLowerCase()) {
    throw new Error("Stale base commit");
  }
  if (git(workspacePath, ["status", "--porcelain"]).trim()) {
    throw new Error("Repository fixture is not clean");
  }

  const workingDirectory =
    operation.workingDirectory === "workspace"
      ? workspacePath
      : path.resolve(workspacePath, operation.workingDirectory);
  if (
    workingDirectory !== workspacePath &&
    !workingDirectory.startsWith(`${path.resolve(workspacePath)}${path.sep}`)
  ) {
    throw new Error("Working directory escapes workspace");
  }
  if (!fs.existsSync(workingDirectory)) {
    throw new Error("Approved working directory does not exist");
  }
  return { source, workingDirectory, head };
}

function changedPaths(workspacePath) {
  const tracked = git(workspacePath, [
    "diff",
    "--name-only",
    "--no-ext-diff",
    "--",
  ])
    .split("\n")
    .filter(Boolean);
  const untracked = git(workspacePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])
    .split("\n")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function isAllowed(changedPath, allowedPaths) {
  return allowedPaths.some(
    (allowed) =>
      changedPath === allowed || changedPath.startsWith(`${allowed}/`),
  );
}

export function verifyRepositoryResult({
  operation: input,
  workspacePath,
}) {
  const operation = validateRepositoryOperation(input);
  const head = git(workspacePath, ["rev-parse", "HEAD"]).trim();
  if (head.toLowerCase() !== operation.baseCommit.toLowerCase()) {
    throw new Error("Repository HEAD changed during execution");
  }

  const actualChangedPaths = changedPaths(workspacePath);
  const unexpected = actualChangedPaths.filter(
    (changedPath) => !isAllowed(changedPath, operation.allowedPaths),
  );
  if (unexpected.length) {
    throw new Error(`Unexpected changed paths: ${unexpected.join(", ")}`);
  }
  const expectedChangedPaths = [...operation.expectedChangedPaths].sort();
  if (
    JSON.stringify(actualChangedPaths) !==
    JSON.stringify(expectedChangedPaths)
  ) {
    throw new Error(
      `Changed paths mismatch: expected ${expectedChangedPaths.join(", ")}, got ${actualChangedPaths.join(", ")}`,
    );
  }

  const diff = git(workspacePath, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-color",
    "--",
  ]);
  const diffHash = crypto.createHash("sha256").update(diff, "utf8").digest("hex");
  if (diffHash !== operation.patchHash) {
    throw new Error(
      `Post-run diff mismatch: expected ${operation.patchHash}, got ${diffHash}`,
    );
  }

  return {
    ok: true,
    head,
    changedPaths: actualChangedPaths,
    diffHash,
  };
}
