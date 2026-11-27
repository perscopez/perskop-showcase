import test from "node:test";
import assert from "node:assert/strict";
import {
  assessDiskPressure,
  assertBuildCapacity,
  parsePosixDf,
} from "../../src/storage/diskPressure.js";

test("disk pressure thresholds are 80% warning and 90% critical", () => {
  assert.equal(assessDiskPressure({ pct: 79, freeBytes: 2e9, totalBytes: 10e9 }), "ok");
  assert.equal(assessDiskPressure({ pct: 80, freeBytes: 2e9, totalBytes: 10e9 }), "warning");
  assert.equal(assessDiskPressure({ pct: 90, freeBytes: 2e9, totalBytes: 10e9 }), "critical");
  assert.equal(assessDiskPressure({ pct: 50, freeBytes: 100, totalBytes: 10e9 }), "critical");
});

test("build capacity rejects critical disk pressure", () => {
  assert.throws(
    () => assertBuildCapacity({ pct: 95, freeBytes: 2e9, totalBytes: 10e9 }),
    /Insufficient disk capacity/,
  );
});

test("POSIX df parser returns exact values", () => {
  assert.deepEqual(
    parsePosixDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1000 850 150 85% /\n"),
    { pct: 85, freeBytes: 153600, totalBytes: 1024000 },
  );
});
