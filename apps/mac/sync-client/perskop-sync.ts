#!/usr/bin/env npx tsx
/**
 * Minimal perskop memory sync client for Mac (pre-Hermes fork integration).
 */
import fs from "node:fs/promises";
import { parseArgs } from "node:util";

const baseUrl = process.env.PERSKOP_API_URL ?? "http://127.0.0.1:8787";
const token = process.env.PERSKOP_API_TOKEN;

if (!token) {
  console.error("Set PERSKOP_API_TOKEN");
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    content: { type: "string" },
    file: { type: "string" },
  },
});

const command = positionals[0] ?? "push";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json();
}

if (command === "status") {
  const data = await api("/api/status");
  console.log(JSON.stringify(data, null, 2));
} else if (command === "push") {
  const content =
    values.content ??
    (values.file ? await fs.readFile(values.file, "utf8") : undefined);
  if (!values.title || !content) {
    console.error("Usage: push --title ... --content ... | --file path");
    process.exit(1);
  }
  const data = await api("/api/memory", {
    method: "POST",
    body: JSON.stringify({
      title: values.title,
      content,
      source: "mac",
    }),
  });
  console.log(JSON.stringify(data, null, 2));
} else {
  console.error("Commands: status | push");
  process.exit(1);
}
