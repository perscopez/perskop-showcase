import { execFileSync } from "node:child_process";

export const DISK_WARN_PCT = 80;
export const DISK_CRITICAL_PCT = 90;
export const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

export type DiskPressureInfo = {
  pct: number;
  freeBytes: number;
  totalBytes: number;
};

export type DiskPressureLevel = "ok" | "warning" | "critical";

export function parsePosixDf(output: string): DiskPressureInfo {
  const lines = output.trim().split("\n");
  const parts = lines.at(-1)?.trim().split(/\s+/) ?? [];
  if (parts.length < 5) throw new Error("Unable to parse df output");
  const totalBytes = Number.parseInt(parts[1], 10) * 1024;
  const freeBytes = Number.parseInt(parts[3], 10) * 1024;
  const pct = Number.parseInt(parts[4].replace("%", ""), 10);
  if (![totalBytes, freeBytes, pct].every(Number.isFinite)) {
    throw new Error("Invalid numeric values in df output");
  }
  return { pct, freeBytes, totalBytes };
}

export function getDiskPressureInfo(dir: string): DiskPressureInfo {
  return parsePosixDf(execFileSync("df", ["-Pk", dir], { encoding: "utf8" }));
}

export function assessDiskPressure(
  info: DiskPressureInfo,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
): DiskPressureLevel {
  if (info.pct >= DISK_CRITICAL_PCT || info.freeBytes < minFreeBytes) return "critical";
  if (info.pct >= DISK_WARN_PCT) return "warning";
  return "ok";
}

export function assertBuildCapacity(
  info: DiskPressureInfo,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
): void {
  if (assessDiskPressure(info, minFreeBytes) === "critical") {
    throw new Error(
      `Insufficient disk capacity: ${info.pct}% used, ${info.freeBytes} bytes free; ` +
        `requires below ${DISK_CRITICAL_PCT}% and at least ${minFreeBytes} bytes free`,
    );
  }
}
