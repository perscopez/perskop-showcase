# perskop

A self-hosted, single-user AI assistant. One small gateway keeps memory, tasks,
mail and calendar in SQLite and routes each request to an AI CLI you are
already logged into (Codex, Cursor Agent, OpenCode, Antigravity) or to any
OpenAI-compatible endpoint. Telegram, a desktop app, a CLI and a web panel all
talk to the same gateway, so they share one memory.

> **Status: prototype.** I use it as a personal tool and it is still changing.
> It is published as a code sample, not as a supported product.

## Features

- **Provider router**: classifies each prompt (conversation, factual,
  repository read/write), picks a provider by capability and risk, falls back
  on failure, and remembers per-provider cooldowns.
- **Shared memory**: SQLite with FTS5 search, a capture policy that decides
  what is worth keeping, secret redaction, and a context builder that adds
  relevant memory to prompts.
- **Approval gates**: repository writes, shell actions, calendar writes and
  outgoing mail need an explicit approval that is bound to a hash of the
  canonical (RFC 8785 JCS) payload, so an approved action cannot be swapped for
  a different one.
- **Sandboxed execution**: coding/shell work runs in short-lived Docker
  containers (read-only root, all capabilities dropped, resource limits,
  internal network only) with outbound traffic forced through a default-deny
  egress proxy.
- **Connectors**: Gmail (sync, drafts, approved send, unsubscribe), Google
  Calendar, iCloud CalDAV and ICS feeds, with OAuth PKCE and encrypted token
  storage.
- **Telegram bot**: allowlisted users, streaming progress, daily morning and
  calendar briefs scheduled with run leases.
- **Multi-device tasks**: a laptop can register as a node, claim tasks and
  report progress with its own token.
- **Clients**: Electron + React desktop app, a `perskop` CLI, and a small
  built-in web control panel.

## Stack

| Part | Tech |
| --- | --- |
| Gateway | Node 22, TypeScript, Fastify 5, better-sqlite3 (FTS5), zod, grammy, imapflow |
| Sandbox executor | Node, Docker Engine API |
| Egress proxy | Node `http`/`net`, no dependencies |
| Desktop | Electron, React 19, Vite 6, Tailwind CSS 4, streamdown |
| Tests | `node:test` (+ `tsx` for TypeScript) |
| Deploy | Docker Compose |

## Architecture

```
 Telegram / desktop / CLI / web panel
                │  bearer token
                ▼
        gateway (Fastify) ──► SQLite: memory, tasks, approvals, connectors
          │        │
          │        └──► provider CLIs on the host  or  OpenAI-compatible endpoint
          ▼
   sandbox-executor ──► throwaway containers ──► egress proxy ──► allowlisted hosts
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
services/
  gateway/                Fastify API, router, memory, connectors, Telegram, cron
  sandbox-executor/       runs agent work in locked-down containers
  provider-egress-proxy/  default-deny CONNECT proxy for those containers
apps/
  perskop-desktop/        Electron + React client
  mac/                    CLI, shared provider helpers, sync script
docker-compose.perskop.yml
```

## Engineering notes

- Approvals store a SHA-256 hash of the JCS-canonicalized payload plus a nonce;
  execution re-checks the hash, and an approval can only be approved while it
  is still pending.
- Sandboxed agents never get the gateway token. They get a one-time,
  task-scoped token for the model proxy, and only its hash is stored.
- Provider failures are normalized (rate limit, auth, timeout, ...) and turned
  into cooldowns, so the router skips a provider that just failed.
- The egress proxy rejects IP literals and private/reserved DNS answers, and
  limits bytes, idle time and total connection time.
- Cron runs take a lease in SQLite, so a restart does not send the same brief
  twice.
- Gmail unsubscribe only follows `https` links to public hosts, refuses
  redirects and requires approval.

## Getting started

Requirements: Node 22+, and at least one provider CLI (for example `codex`) if
you want the CLI-based providers.

```bash
cd services/gateway
cp .env.example .env        # set PERSKOP_API_TOKEN at minimum
npm install
npm run dev                 # http://127.0.0.1:8787 (set HOST=127.0.0.1 for local use)
```

```bash
curl http://127.0.0.1:8787/api/health
curl -H "Authorization: Bearer $PERSKOP_API_TOKEN" http://127.0.0.1:8787/api/status
```

Tests:

```bash
cd services/gateway && npm test                   # 147 tests
cd services/sandbox-executor && npm test          # 12 tests
cd services/provider-egress-proxy && npm test     # 8 tests
```

Desktop app: see [apps/perskop-desktop/README.md](apps/perskop-desktop/README.md).

Docker: copy `.env.example` to `.env` at the repository root, create
`services/gateway/.env`, then `docker compose -f docker-compose.perskop.yml up -d --build`.
The gateway is published on `127.0.0.1` only.

## Security defaults

- Every API route except `/api/health` and the OAuth callbacks needs the bearer token (compared in constant time).
- `PERSKOP_FULL_ACCESS` is `false` by default. When it is `true`, host-side
  provider CLIs run without their own permission prompts, so only enable it on
  a machine you fully control.
- An empty Telegram allowlist blocks everyone.
- Gateway secrets are removed from the environment passed to provider CLIs.

## Known limitations

- Single user, single token. No multi-tenant auth or per-client scopes.
- No rate limiting on the API; it is meant to sit behind localhost or a tunnel.
- Some user-facing strings are in Turkish.
- The desktop app has no automated tests and no TypeScript type check yet.
- `npm audit` still reports issues that need major upgrades (Electron, zod,
  `@fastify/static`).

## How it was built

I designed and directed this project and built it with AI coding assistants
(Claude Code and Codex): I set the architecture, requirements and security
rules, and reviewed and tested the changes.

## License

[MIT](LICENSE)
