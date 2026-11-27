import path from "node:path";
import { recoverSqliteDatabase } from "../src/storage/sqliteRecovery.js";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const result = await recoverSqliteDatabase({
  dbPath: path.join(dataDir, "perskop.db"),
  backupDir: path.join(dataDir, "backups"),
  writersStopped: process.env.PERSKOP_WRITERS_STOPPED === "1",
  allowDeleteJournalFallback: process.argv.includes("--allow-delete-journal"),
});
console.log(JSON.stringify(result, null, 2));
