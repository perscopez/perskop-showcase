# Architecture

perskop is a single-user AI assistant. A small always-on server (the
**gateway**) holds memory, tasks and connectors and routes each request to an AI
coding/chat CLI the owner is already logged into (Codex, Cursor Agent, OpenCode,
Antigravity `agy`) or to any OpenAI-compatible endpoint. Clients (Telegram, a
desktop app, a CLI, a small web panel) all talk to that one gateway, so they
share the same memory and task history.

```
 Phone ── Telegram ──┐
 Desktop app ────────┤                       ┌─ provider CLIs (codex, cursor-agent, opencode, agy)
 CLI / sync client ──┼──► gateway (Fastify) ─┼─ OpenAI-compatible endpoint (direct_model)
 Web control panel ──┘     │                 └─ sandbox-executor ──► short-lived Docker containers
                           │                                              │
                           ├─ SQLite (+FTS5): memory, tasks, approvals    └─► provider-egress-proxy ──► allowlisted hosts
                           ├─ connectors: Gmail, Google Calendar, iCloud CalDAV, ICS
                           └─ cron: daily brief, mail sync
```

## Components

### services/gateway

TypeScript, Fastify 5, better-sqlite3. Everything except `/api/health` and the
OAuth callbacks requires a bearer token.

| Area | Modules | What it does |
| --- | --- | --- |
| API | `src/api/*` | Chat (JSON or SSE), memory, tasks, approvals, cron, mail, calendar, nodes, remote sessions, and an OpenAI-compatible `/v1/chat/completions` for sandboxed agents |
| Provider routing | `src/providers/*` | Classifies each prompt (conversation, factual, repository read/write), picks a provider by capability and risk, falls back on failure and keeps per-provider cooldowns in SQLite |
| Memory | `src/memory/*`, `src/db.ts` | SQLite with FTS5 search, a capture policy that decides what is worth storing, secret redaction, and a context builder that packs relevant memory into prompts |
| Tasks | `src/tasks/*` | A task state machine with revisions; remote nodes (e.g. a laptop) register, heartbeat, claim and complete tasks with their own node tokens |
| Approvals | `src/security/*`, `src/utils/jcs.ts` | Risky operations (repository writes, shell actions, calendar writes, sending mail) create an approval bound to a hash of the canonical (JCS) payload; execution only runs if the approved payload still matches |
| Connectors | `src/connectors/*` | Google OAuth (PKCE, encrypted state), Gmail sync/drafts/approved send/unsubscribe, Google Calendar, iCloud CalDAV, ICS subscriptions; connector secrets are encrypted with a master key |
| Mail | `src/email/*` | IMAP and Gmail sync, rule-based classification, inbox context for briefs |
| Scheduling | `src/cron/*` | Cron jobs with run leases so a brief is sent once even if the process restarts |
| Telegram | `src/telegram/*` | grammy bot with a user-ID allowlist, progress messages, chunked replies, memory/task/remote commands |
| Ops | `src/storage/*`, `scripts/recover-sqlite.ts` | Disk-pressure checks and SQLite recovery |

### services/sandbox-executor

A small Node HTTP service that talks to the Docker socket and runs agent work
in throwaway containers: fixed image, read-only root filesystem, all
capabilities dropped, `no-new-privileges`, memory/CPU/PID limits, and an
internal-only network. For repository work it prepares an isolated workspace
and runs a separate verification container with networking disabled.

### services/provider-egress-proxy

A default-deny HTTP `CONNECT` proxy. It is the only container on both the
internal sandbox network and the external network. It allows only listed hosts
on listed ports, rejects IP literals and private/reserved DNS answers, caps
bytes and connection time, and redacts secrets from its logs.

### apps

- `apps/perskop-desktop`: Electron + React 19 + Vite chat client (cloud mode via
  the gateway, or local mode that runs a CLI on the machine and syncs the result).
- `apps/mac/cli`: `perskop` command-line client (status, memory, chat).
- `apps/mac/lib`: shared provider helpers used by the CLI and the desktop app.
- `apps/mac/sync-client`: minimal script that pushes a note into gateway memory.

## Request flow (chat)

1. A client sends `POST /api/chat` with a bearer token.
2. The gateway classifies the prompt, builds a context package from memory and
   selects a provider by capability, risk and current cooldowns.
3. The workload picks an engine: deterministic tools (memory, file reads),
   the direct model endpoint, or the sandbox executor for coding and shell
   work. Repository writes need an approved operation first, and the sandbox
   gets a short-lived scoped token (only its hash is stored) to call the
   gateway's model proxy. Provider CLIs that run on the host only skip their
   own permission prompts when `PERSKOP_FULL_ACCESS=true`.
4. The answer streams back (SSE) and the conversation is stored in memory
   according to the capture policy.

## Deployment

`docker-compose.perskop.yml` runs the three services. The gateway port is bound
to `127.0.0.1` only; remote clients are expected to use an SSH tunnel or a
private network. `PERSKOP_FULL_ACCESS` defaults to `false`.
