# perskop desktop

Electron + React chat client for the perskop gateway.

- **Cloud mode** (default): sends prompts to the gateway `/api/chat`, which routes them to a provider CLI on the server and stores the result in shared memory.
- **Local mode**: runs an installed CLI on this machine (`codex`, `cursor-agent`, `opencode`, `agy`) and syncs the answer to gateway memory.
- Multiple chat sessions (kept in `localStorage`), Markdown rendering via `streamdown`, memory preview in the sidebar.

## Requirements

A config file at `~/.perskop/config.json` (or set `PERSKOP_CONFIG`), see `apps/mac/cli/config.example.json`:

```json
{ "apiUrl": "http://127.0.0.1:8787", "apiToken": "REPLACE_WITH_GATEWAY_TOKEN" }
```

If the gateway runs on a remote host, keep it bound to localhost there and reach it through an SSH tunnel, for example `ssh -L 8787:127.0.0.1:8787 <your-server>`.

## Development

```bash
cd apps/perskop-desktop
npm install
npm run dev     # Vite on 127.0.0.1:5175 + Electron
npm run build   # production renderer bundle in dist/
```
