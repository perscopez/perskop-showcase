import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAC_PROVIDERS = ["cursor", "codex", "agy", "opencode"];
export const VPS_PROVIDERS = ["codex", "cursor", "opencode", "agy"];

function commandExists(cmd) {
  if (!cmd) return false;
  try {
    // execFileSync with an args array: the command name never reaches a shell.
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function listLocalProviders(config) {
  const map = {
    cursor: config.cursorCmd,
    codex: config.codexCmd,
    agy: config.agyCmd,
    opencode: config.openCodeCmd,
  };
  return MAC_PROVIDERS.filter((p) => commandExists(map[p]));
}

export function loadPerskopConfig() {
  const configPath =
    process.env.PERSKOP_CONFIG ??
    path.join(os.homedir(), ".perskop", "config.json");
  const file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    apiUrl: process.env.PERSKOP_API_URL ?? file.apiUrl ?? "http://127.0.0.1:8787",
    apiToken: process.env.PERSKOP_API_TOKEN ?? file.apiToken,
    codexCmd: file.codexCmd ?? "codex",
    cursorCmd: file.cursorCmd ?? "cursor-agent",
    agyCmd: file.agyCmd ?? "agy",
    openCodeCmd: file.openCodeCmd ?? "opencode",
  };
}

function run(cmd, args, cwd, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(`${cmd} kurulu değil`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || stderr.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
  });
}

async function runOne(config, provider, prompt, cwd) {
  if (provider === "codex") {
    const out = await run(
      config.codexCmd,
      ["exec", "--sandbox", "read-only", "--skip-git-repo-check", prompt],
      cwd,
    );
    return { provider, output: out };
  }
  if (provider === "cursor") {
    const out = await run(
      config.cursorCmd,
      ["-p", "-f", "--output-format", "text", prompt],
      cwd,
    );
    return { provider, output: out };
  }
  if (provider === "agy") {
    const out = await run(config.agyCmd, ["chat", prompt], cwd);
    return { provider, output: out };
  }
  const out = await run(config.openCodeCmd, ["run", prompt], cwd);
  return { provider: "opencode", output: out };
}

export async function routeMacPrompt(config, prompt, preferred, cwd = process.cwd()) {
  const available = listLocalProviders(config);
  const order = preferred
    ? [preferred]
    : available.length > 0
      ? available
      : ["codex"];
  let last;
  for (const p of order) {
    try {
      return await runOne(config, p, prompt, cwd);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no providers available");
}

/** Mac app default: VPS Codex/Cursor (fast, already logged in on server). */
export async function chatViaVps(config, prompt, provider) {
  const res = await fetch(`${config.apiUrl}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      provider: provider && provider !== "auto" ? provider : undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  if (data.error) throw new Error(data.error);
  return {
    provider: data.provider,
    output: data.output,
    memoryId: data.memory?.id,
    via: "vps",
  };
}

export async function fetchMemory(config, limit = 20) {
  const res = await fetch(`${config.apiUrl}/api/memory?limit=${limit}`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export async function syncMemory(config, { title, content, provider }) {
  const res = await fetch(`${config.apiUrl}/api/memory`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      content,
      source: "mac",
      provider,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
