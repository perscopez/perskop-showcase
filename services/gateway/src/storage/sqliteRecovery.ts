import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type SqliteRecoveryOptions = {
  dbPath: string;
  backupDir: string;
  writersStopped: boolean;
  allowDeleteJournalFallback?: boolean;
  now?: Date;
};

export type SqliteRecoveryResult = {
  backupPath: string;
  checkpoint: { busy: number; log: number; checkpointed: number };
  journalMode: "wal" | "delete";
  integrity: "ok";
};

function integrityCheck(db: Database.Database): void {
  const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${JSON.stringify(rows)}`);
  }
}

export async function recoverSqliteDatabase(
  options: SqliteRecoveryOptions,
): Promise<SqliteRecoveryResult> {
  if (!options.writersStopped) {
    throw new Error("SQLite recovery refused: database writers must be stopped first");
  }

  fs.mkdirSync(options.backupDir, { recursive: true });
  const lockPath = `${options.dbPath}.recovery.lock`;
  const lockFd = fs.openSync(lockPath, "wx", 0o600);
  let db: Database.Database | undefined;
  try {
    db = new Database(options.dbPath, { timeout: 10_000 });
    integrityCheck(db);

    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(options.backupDir, `perskop-${stamp}.db`);
    await db.backup(backupPath);
    const backupDb = new Database(backupPath, { readonly: true });
    try {
      integrityCheck(backupDb);
    } finally {
      backupDb.close();
    }

    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const checkpoint = rows[0];
    if (!checkpoint || checkpoint.busy !== 0) {
      throw new Error(`SQLite WAL checkpoint was busy: ${JSON.stringify(rows)}`);
    }

    integrityCheck(db);
    let journalMode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
    if (journalMode !== "wal") {
      if (!options.allowDeleteJournalFallback) {
        throw new Error(`SQLite journal mode is ${journalMode}; explicit DELETE fallback not authorized`);
      }
      journalMode = String(db.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
    }
    if (journalMode !== "wal" && journalMode !== "delete") {
      throw new Error(`Unsupported SQLite journal mode after recovery: ${journalMode}`);
    }
    integrityCheck(db);

    return {
      backupPath,
      checkpoint,
      journalMode: journalMode as "wal" | "delete",
      integrity: "ok",
    };
  } finally {
    try {
      db?.close();
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    }
  }
}
