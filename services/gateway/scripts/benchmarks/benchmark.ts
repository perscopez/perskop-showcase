import { classifyPrompt, routePrompt } from "../../src/providers/router.js";
import { MemoryStore } from "../../src/db.js";
import type { AppConfig } from "../../src/config.js";
import crypto from "node:crypto";
import fs from "node:fs";

const config: AppConfig = {
  PORT: 8787,
  HOST: "0.0.0.0",
  DATA_DIR: "./test-benchmark-workspace",
  PERSKOP_API_TOKEN: "bench",
  CODEX_CMD: "codex",
  CURSOR_CMD: "cursor-agent",
  OPENCODE_CMD: "opencode",
  AGY_CMD: "agy",
  DEFAULT_PROVIDER: "codex",
  EMAIL_IMAP_HOST: "imap.gmail.com",
  EMAIL_IMAP_PORT: 993,
  EMAIL_SMTP_HOST: "smtp.gmail.com",
  EMAIL_SMTP_PORT: 587,
  CRON_EMAIL_ENABLED: false,
  CRON_MORNING_BRIEF: "0 8 * * *",
  CRON_TZ: "Europe/Istanbul",
  PERSKOP_FULL_ACCESS: true,
  allowedTelegramUserIds: [],
  PERSKOP_LLM_PROXY_URL: "http://mock-proxy",
  PERSKOP_LLM_PROXY_SECRET: "mock-secret",
  PERSKOP_EXECUTOR_URL: "http://mock-executor",
  PERSKOP_EXECUTOR_TOKEN: "mock-token",
};

// Suppress console logs during benchmarking to keep output clean
const originalLog = console.log;
const originalError = console.error;

// Mock global fetch with minimal latency to isolate framework overhead
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  const urlStr = String(url);
  if (urlStr.includes("/chat/completions")) {
    const stream = new ReadableStream({
      start(controller) {
        const chunk = JSON.stringify({
          choices: [{ delta: { content: "Mocked LLM reply" } }],
        });
        controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }
  if (urlStr.includes("/execute")) {
    return new Response(
      JSON.stringify({ exitCode: 0, output: "Mocked sandbox execution" }),
      { status: 200 },
    );
  }
  return new Response("Not Found", { status: 404 });
}) as any;

const workloads = [
  { name: "Greeting (Direct LLM)", prompt: "Merhaba nasılsın?" },
  { name: "Factual Question (Direct LLM)", prompt: "Almanya vizesi için gerekli belgeler nelerdir?" },
  { name: "System Status (Deterministic Tool)", prompt: "sistem durumunu göster" },
  { name: "Email Listing (Deterministic Tool)", prompt: "son mailleri göster" },
  { name: "Email Summary (Direct LLM + Mail Tool)", prompt: "son maili özetle" },
  { name: "Memory Recall (Deterministic Tool)", prompt: "geçmiş konuşmaları hatırla" },
  { name: "Git Status (Deterministic Tool)", prompt: "git status" },
  { name: "Repository Write (Sandboxed Codex CLI)", prompt: "Modify index.js to write code" },
];

function percentile(arr: number[], pct: number) {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runBenchmark() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
  const memory = new MemoryStore(config.DATA_DIR);

  const results: Record<string, number[]> = {};

  for (const wl of workloads) {
    results[wl.name] = [];

    // Mute console logs
    console.log = () => {};
    console.error = () => {};

    // 1. Cold runs (20 runs)
    for (let i = 0; i < 20; i++) {
      await routePrompt(config, wl.prompt, undefined, { memory, taskId: 9999 + i, approved: true });
    }

    // 2. Warm runs (50 runs)
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await routePrompt(config, wl.prompt, undefined, { memory, taskId: 10000 + i, approved: true });
      const duration = performance.now() - start;
      results[wl.name].push(duration);
    }
  }

  // Restore console logs
  console.log = originalLog;
  console.error = originalError;

  // Print Report
  console.log("\n======================================================================");
  console.log("LATENCY BENCHMARK REPORT (50 Warm Runs per Workload)");
  console.log("======================================================================");
  console.log(
    `${"Workload".padEnd(40)} | ${"P50 (ms)".padStart(10)} | ${"P95 (ms)".padStart(10)} | ${"P99 (ms)".padStart(10)}`,
  );
  console.log("----------------------------------------------------------------------");
  for (const wl of workloads) {
    const latencies = results[wl.name];
    const p50 = percentile(latencies, 50).toFixed(2);
    const p95 = percentile(latencies, 95).toFixed(2);
    const p99 = percentile(latencies, 99).toFixed(2);
    console.log(
      `${wl.name.padEnd(40)} | ${p50.padStart(10)} | ${p95.padStart(10)} | ${p99.padStart(10)}`,
    );
  }
  console.log("======================================================================\n");

  memory.db.close();
  try {
    fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
  } catch {}
}

runBenchmark().finally(() => {
  globalThis.fetch = originalFetch;
});
