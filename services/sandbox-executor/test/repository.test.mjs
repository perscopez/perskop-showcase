import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  prepareRepositoryWorkspace,
  verifyRepositoryResult,
} from "../repository.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-repository-"));
  const repositories = path.join(root, "repositories");
  const source = path.join(repositories, "perskop");
  const workspace = path.join(root, "workspaces", "task-1");
  fs.mkdirSync(source, { recursive: true });
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.email", "perskop@example.invalid"]);
  git(source, ["config", "user.name", "Perskop Test"]);
  fs.writeFileSync(path.join(source, "README.md"), "Perskop\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "--quiet", "-m", "base"]);
  const baseCommit = git(source, ["rev-parse", "HEAD"]).trim();
  fs.appendFileSync(path.join(source, "README.md"), "approved\n");
  const patch = git(source, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-color",
    "--",
  ]);
  git(source, ["reset", "--hard", "--quiet", "HEAD"]);
  const operation = {
    schemaVersion: 1,
    repositoryId: "perskop",
    workingDirectory: "workspace",
    baseCommit,
    allowedPaths: ["README.md"],
    patch,
    patchHash: crypto.createHash("sha256").update(patch).digest("hex"),
    expectedChangedPaths: ["README.md"],
    engine: "codex",
    timeoutSeconds: 30,
    verificationCommand: ["/usr/bin/true"],
    expectedExitCode: 0,
  };
  return { root, repositories, source, workspace, operation };
}

test("prepares an exact clean detached base and verifies approved result", () => {
  const item = fixture();
  try {
    const prepared = prepareRepositoryWorkspace({
      operation: item.operation,
      repositoryRoot: item.repositories,
      workspacePath: item.workspace,
    });
    assert.equal(prepared.head, item.operation.baseCommit);
    fs.appendFileSync(path.join(item.workspace, "README.md"), "approved\n");
    const result = verifyRepositoryResult({
      operation: item.operation,
      workspacePath: item.workspace,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedPaths, ["README.md"]);
    assert.equal(result.diffHash, item.operation.patchHash);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("rejects stale base commits before execution", () => {
  const item = fixture();
  try {
    assert.throws(
      () =>
        prepareRepositoryWorkspace({
          operation: { ...item.operation, baseCommit: "f".repeat(40) },
          repositoryRoot: item.repositories,
          workspacePath: item.workspace,
        }),
      /git cat-file failed/,
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("rejects unexpected paths and exact diff mismatches", () => {
  const item = fixture();
  try {
    prepareRepositoryWorkspace({
      operation: item.operation,
      repositoryRoot: item.repositories,
      workspacePath: item.workspace,
    });
    fs.writeFileSync(path.join(item.workspace, "secret.txt"), "unexpected\n");
    assert.throws(
      () =>
        verifyRepositoryResult({
          operation: item.operation,
          workspacePath: item.workspace,
        }),
      /Unexpected changed paths/,
    );

    fs.rmSync(path.join(item.workspace, "secret.txt"));
    fs.appendFileSync(path.join(item.workspace, "README.md"), "different\n");
    assert.throws(
      () =>
        verifyRepositoryResult({
          operation: item.operation,
          workspacePath: item.workspace,
        }),
      /Post-run diff mismatch/,
    );
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("prepares from a read-only style bare repository mirror", () => {
  const item = fixture();
  const bare = path.join(item.root, "bare", "perskop");
  try {
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(item.root, ["clone", "--bare", "--quiet", item.source, bare]);
    const prepared = prepareRepositoryWorkspace({
      operation: item.operation,
      repositoryRoot: path.dirname(bare),
      workspacePath: item.workspace,
    });
    assert.equal(prepared.head, item.operation.baseCommit);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
