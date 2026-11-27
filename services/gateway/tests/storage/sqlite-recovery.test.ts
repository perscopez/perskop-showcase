import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { recoverSqliteDatabase } from "../../src/storage/sqliteRecovery.js";

test("recovery refuses to run until writers are explicitly stopped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-recovery-"));
  const dbPath = path.join(dir, "perskop.db");
  new Database(dbPath).close();
  await assert.rejects(
    recoverSqliteDatabase({ dbPath, backupDir: path.join(dir, "backups"), writersStopped: false }),
    /writers must be stopped/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recovery backs up, checkpoints, verifies integrity, and never unlinks WAL or SHM", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-recovery-"));
  const dbPath = path.join(dir, "perskop.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY); INSERT INTO evidence VALUES ('kept')");
  db.close();

  const originalRmSync = fs.rmSync;
  const originalUnlinkSync = fs.unlinkSync;
  const destructiveCalls: string[] = [];
  (fs as any).rmSync = (target: fs.PathLike, ...args: any[]) => {
    if (String(target).endsWith("-wal") || String(target).endsWith("-shm")) destructiveCalls.push(String(target));
    return (originalRmSync as any)(target, ...args);
  };
  (fs as any).unlinkSync = (target: fs.PathLike) => {
    if (String(target).endsWith("-wal") || String(target).endsWith("-shm")) destructiveCalls.push(String(target));
    return originalUnlinkSync(target);
  };

  let result;
  try {
    result = await recoverSqliteDatabase({
      dbPath,
      backupDir: path.join(dir, "backups"),
      writersStopped: true,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
  } finally {
    (fs as any).rmSync = originalRmSync;
    (fs as any).unlinkSync = originalUnlinkSync;
  }
  assert.equal(result.integrity, "ok");
  const backupDb = new Database(result.backupPath, { readonly: true });
  assert.equal(backupDb.pragma("integrity_check", { simple: true }), "ok");
  backupDb.close();
  assert.deepEqual(destructiveCalls, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
