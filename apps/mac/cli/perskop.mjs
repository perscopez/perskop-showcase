#!/usr/bin/env node
/**
 * perskop Mac CLI: run a prompt on a local provider CLI and sync the result to gateway memory.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const configPath =
  process.env.PERSKOP_CONFIG ??
  path.join(os.homedir(), ".perskop", "config.json");

function loadConfig() {
  const fromEnv = {
    apiUrl: process.env.PERSKOP_API_URL,
    apiToken: process.env.PERSKOP_API_TOKEN,
    codexCmd: process.env.CODEX_CMD ?? "codex",
    cursorCmd: process.env.CURSOR_CMD ?? "cursor-agent",
    agyCmd: process.env.AGY_CMD ?? "agy",
  };

  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    // optional file
  }

  const apiUrl = fromEnv.apiUrl ?? file.apiUrl ?? "http://127.0.0.1:8787";
  const apiToken = fromEnv.apiToken ?? file.apiToken;

  return {
    apiUrl,
    apiToken,
    codexCmd: fromEnv.codexCmd ?? file.codexCmd ?? "codex",
    cursorCmd: fromEnv.cursorCmd ?? file.cursorCmd ?? "cursor-agent",
    agyCmd: fromEnv.agyCmd ?? file.agyCmd ?? "agy",
  };
}

function run(cmd, args, cwd = process.cwd(), timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || stderr.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
  });
}

async function api(config, path, init) {
  if (!config.apiToken) {
    console.error("API token missing. Set PERSKOP_API_TOKEN or configure it in config.json");
    process.exit(1);
  }
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const MAC_ORDER = ["cursor", "codex", "agy"];

async function runProvider(config, provider, prompt) {
  if (provider === "codex") {
    const out = await run(config.codexCmd, [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      prompt,
    ]);
    return { provider, out };
  }
  if (provider === "cursor") {
    const out = await run(config.cursorCmd, [
      "-p",
      "-f",
      "--output-format",
      "text",
      prompt,
    ]);
    return { provider, out };
  }
  const out = await run(config.agyCmd, ["chat", prompt]);
  return { provider: "agy", out };
}

async function routeMac(config, prompt, preferred) {
  const order = preferred ? [preferred] : MAC_ORDER;
  let last;
  for (const p of order) {
    try {
      return await runProvider(config, p, prompt);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no providers");
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = positionals[0];
const config = loadConfig();

if (values.help || !cmd) {
  console.log(`Usage:
  perskop status
  perskop memory
  perskop push --title "x" --content "y"
  perskop chat "your prompt" [--provider codex|cursor|agy]

Config: ${configPath}
Gateway: ${config.apiUrl} (set PERSKOP_API_URL or apiUrl in config.json)`);
  process.exit(0);
}

if (cmd === "status") {
  console.log(JSON.stringify(await api(config, "/api/status"), null, 2));
} else if (cmd === "memory") {
  console.log(JSON.stringify(await api(config, "/api/memory?limit=10"), null, 2));
} else if (cmd === "push") {
  const title = values.title;
  const content = values.content ?? positionals.slice(1).join(" ");
  if (!title || !content) {
    console.error("perskop push --title ... --content ...");
    process.exit(1);
  }
  const saved = await api(config, "/api/memory", {
    method: "POST",
    body: JSON.stringify({ title, content, source: "mac" }),
  });
  console.log(JSON.stringify(saved, null, 2));
} else if (cmd === "chat") {
  const prompt = positionals.slice(1).join(" ").trim();
  if (!prompt) {
    console.error("perskop chat \"prompt\"");
    process.exit(1);
  }
  const preferred = values.provider;
  console.error(`→ running (${preferred ?? MAC_ORDER.join("→")})...`);
  const { provider, out } = await routeMac(config, prompt, preferred);
  console.log(`[${provider}]\n${out}`);
  const saved = await api(config, "/api/memory", {
    method: "POST",
    body: JSON.stringify({
      title: prompt.slice(0, 80),
      content: out,
      source: "mac",
      provider,
    }),
  });
  console.error(`→ synced to VPS memory #${saved.item.id}`);
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
