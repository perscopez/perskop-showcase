# Perskop provider egress proxy

Default-deny CONNECT proxy for isolated provider CLI containers.

## Policy

- Only `CONNECT` is accepted.
- Destination ports default to `443`.
- IP-literal targets and private/reserved DNS answers are rejected.
- Allowlist entries are comma-separated exact hosts or suffixes beginning with `.`.
- Connections have per-direction byte, idle, and total-duration limits.
- Logs never include proxy request headers or tunneled contents and redact common secret forms.

## Environment

- `PROVIDER_EGRESS_ALLOWLIST`
- `PROVIDER_EGRESS_PORTS` (default `443`)
- `PROVIDER_EGRESS_MAX_BYTES` (default 64 MiB per direction)
- `PROVIDER_EGRESS_MAX_CONNECTION_MS` (default 10 minutes)
- `PROVIDER_EGRESS_IDLE_MS` (default 60 seconds)
- `PORT` (default `18888`)

The sandbox executor must attach child containers only to the internal sandbox network and set `HTTP_PROXY`/`HTTPS_PROXY` to this service. The proxy alone joins both the internal network and the external provider network.
