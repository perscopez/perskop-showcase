import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { domainToASCII, pathToFileURL } from "node:url";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONNECTION_MS = 10 * 60_000;
const DEFAULT_IDLE_MS = 60_000;

export function redactLogText(value) {
  return String(value)
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*)[^\s&#,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function normalizeHost(host) {
  if (!host || /[\s/@?#:\[\]]/.test(host)) return null;
  const ascii = domainToASCII(host.replace(/\.$/, "").toLowerCase());
  if (!ascii || ascii.length > 253) return null;
  return ascii;
}

function parseAuthority(authority) {
  if (!authority || authority.includes("[") || authority.includes("]")) return null;
  const separator = authority.lastIndexOf(":");
  if (separator <= 0 || separator === authority.length - 1) return null;
  const host = normalizeHost(authority.slice(0, separator));
  const portText = authority.slice(separator + 1);
  if (!host || !/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

function compileAllowlist(entries) {
  const exact = new Set();
  const suffixes = [];
  for (const raw of entries) {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith(".")) {
      const suffix = normalizeHost(entry.slice(1));
      if (suffix) suffixes.push(`.${suffix}`);
      continue;
    }
    const host = normalizeHost(entry);
    if (host) exact.add(host);
  }
  return { exact, suffixes };
}

function hostAllowed(host, allowlist) {
  if (net.isIP(host)) return false;
  if (allowlist.exact.has(host)) return true;
  return allowlist.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

function ipv4Number(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(value, base, bits) {
  const baseValue = ipv4Number(base);
  if (value == null || baseValue == null) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(baseValue / size);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const blocked = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => inV4Range(value, base, bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase().split("%")[0];
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower)) return false;
    if (lower.startsWith("ff")) return false;
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
    return true;
  }
  return false;
}

function status(socket, code, reason) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function protectTunnel(client, upstream, options, initialHead) {
  let clientBytes = 0;
  let upstreamBytes = 0;
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  const count = (direction) => (chunk) => {
    if (direction === "client") clientBytes += chunk.length;
    else upstreamBytes += chunk.length;
    if (clientBytes > options.maxBytesPerDirection || upstreamBytes > options.maxBytesPerDirection) {
      options.log("warn", "tunnel byte limit exceeded");
      closeBoth();
    }
  };
  client.on("data", count("client"));
  upstream.on("data", count("upstream"));
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.setTimeout(options.idleMs, closeBoth);
  upstream.setTimeout(options.idleMs, closeBoth);
  const durationTimer = setTimeout(closeBoth, options.maxConnectionMs);
  durationTimer.unref?.();
  client.on("close", () => clearTimeout(durationTimer));
  if (initialHead?.length) {
    clientBytes += initialHead.length;
    if (clientBytes > options.maxBytesPerDirection) return closeBoth();
    upstream.write(initialHead);
  }
  client.pipe(upstream);
  upstream.pipe(client);
}

export function createEgressProxy(input = {}) {
  const allowlist = compileAllowlist(input.allowlist ?? []);
  const allowedPorts = new Set(input.allowedPorts ?? [443]);
  const lookup = input.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true }));
  const logger = input.logger ?? (() => {});
  const options = {
    maxBytesPerDirection: input.maxBytesPerDirection ?? DEFAULT_MAX_BYTES,
    maxConnectionMs: input.maxConnectionMs ?? DEFAULT_MAX_CONNECTION_MS,
    idleMs: input.idleMs ?? DEFAULT_IDLE_MS,
    allowPrivateAddresses: input.allowPrivateAddresses === true,
    log(level, message) {
      logger({ level, message: redactLogText(message), timestamp: new Date().toISOString() });
    },
  };

  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: "close", "Content-Type": "text/plain" });
    response.end("CONNECT required\n");
  });

  server.on("connect", async (request, client, head) => {
    const authority = parseAuthority(request.url);
    if (!authority) return status(client, 400, "Bad Request");
    if (!allowedPorts.has(authority.port) || !hostAllowed(authority.host, allowlist)) {
      options.log("warn", `CONNECT denied host=${authority.host} port=${authority.port}`);
      return status(client, 403, "Forbidden");
    }
    let addresses;
    try {
      addresses = await lookup(authority.host);
    } catch (error) {
      options.log("warn", `DNS failed host=${authority.host} error=${error?.code ?? "unknown"}`);
      return status(client, 502, "Bad Gateway");
    }
    const candidates = Array.isArray(addresses) ? addresses : [addresses];
    const selected = candidates.find((item) => item?.address && (options.allowPrivateAddresses || isPublicAddress(item.address)));
    if (!selected) {
      options.log("warn", `DNS denied non-public answer host=${authority.host}`);
      return status(client, 403, "Forbidden");
    }

    const upstream = net.connect({ host: selected.address, port: authority.port, family: selected.family });
    upstream.once("connect", () => {
      if (client.destroyed) return upstream.destroy();
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: perskop-egress\r\n\r\n");
      protectTunnel(client, upstream, options, head);
    });
    upstream.once("error", (error) => {
      options.log("warn", `upstream connect failed host=${authority.host} code=${error?.code ?? "unknown"}`);
      status(client, 502, "Bad Gateway");
    });
  });

  return server;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const proxy = createEgressProxy({
    allowlist: (process.env.PROVIDER_EGRESS_ALLOWLIST ?? "").split(","),
    allowedPorts: (process.env.PROVIDER_EGRESS_PORTS ?? "443").split(",").map(Number).filter(Number.isInteger),
    maxBytesPerDirection: parseNumber(process.env.PROVIDER_EGRESS_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxConnectionMs: parseNumber(process.env.PROVIDER_EGRESS_MAX_CONNECTION_MS, DEFAULT_MAX_CONNECTION_MS),
    idleMs: parseNumber(process.env.PROVIDER_EGRESS_IDLE_MS, DEFAULT_IDLE_MS),
    logger: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  });
  const port = parseNumber(process.env.PORT, 18888);
  proxy.listen(port, "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ level: "info", message: "provider egress proxy listening", port })}\n`);
  });
}
