import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import {
  createEgressProxy,
  redactLogText,
} from "../src/server.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function connectRaw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) resolve({ socket, data });
    });
    socket.on("error", reject);
  });
}

test("allows exact and suffix allowlisted CONNECT hosts", async () => {
  const target = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  const proxy = createEgressProxy({
    allowlist: ["allowed.test", ".provider.test"],
    allowedPorts: [targetPort],
    allowPrivateAddresses: true,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const proxyPort = await listen(proxy);
  try {
    for (const host of ["allowed.test", "api.provider.test"]) {
      const { socket, data } = await connectRaw(
        proxyPort,
        `CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`,
      );
      assert.match(data, /200 Connection Established/);
      socket.destroy();
    }
  } finally {
    await close(proxy);
    await close(target);
  }
});

test("rejects arbitrary hosts, suffix confusion, and IP literals", async () => {
  const proxy = createEgressProxy({ allowlist: ["allowed.test", ".provider.test"] });
  const port = await listen(proxy);
  try {
    for (const host of ["example.com", "provider.test.evil.com", "127.0.0.1", "[::1]"]) {
      const { socket, data } = await connectRaw(
        port,
        `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
      );
      assert.match(data, /403 Forbidden|400 Bad Request/);
      socket.destroy();
    }
  } finally {
    await close(proxy);
  }
});

test("rejects ordinary HTTP proxy requests", async () => {
  const proxy = createEgressProxy({ allowlist: ["allowed.test"] });
  const port = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/https://allowed.test/secret`);
    assert.equal(response.status, 405);
  } finally {
    await close(proxy);
  }
});

test("fails closed on DNS failure or private DNS answers", async () => {
  const dnsFailure = createEgressProxy({
    allowlist: ["allowed.test"],
    lookup: async () => { throw Object.assign(new Error("dns down"), { code: "ENOTFOUND" }); },
  });
  const dnsPort = await listen(dnsFailure);
  const privateAnswer = createEgressProxy({
    allowlist: ["allowed.test"],
    lookup: async () => [{ address: "10.0.0.4", family: 4 }],
  });
  const privatePort = await listen(privateAnswer);
  try {
    const first = await connectRaw(dnsPort, "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n");
    assert.match(first.data, /502 Bad Gateway/);
    first.socket.destroy();
    const second = await connectRaw(privatePort, "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n");
    assert.match(second.data, /403 Forbidden/);
    second.socket.destroy();
  } finally {
    await close(dnsFailure);
    await close(privateAnswer);
  }
});

test("enforces connection byte and duration limits", async () => {
  const target = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  const proxy = createEgressProxy({
    allowlist: ["allowed.test"],
    allowedPorts: [targetPort],
    allowPrivateAddresses: true,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    maxBytesPerDirection: 4,
    maxConnectionMs: 30,
  });
  const port = await listen(proxy);
  try {
    const { socket } = await connectRaw(port, `CONNECT allowed.test:${targetPort} HTTP/1.1\r\n\r\n`);
    const closed = once(socket, "close");
    socket.write("12345");
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket did not close")), 250)),
    ]);

    const second = await connectRaw(port, `CONNECT allowed.test:${targetPort} HTTP/1.1\r\n\r\n`);
    const timedClose = once(second.socket, "close");
    await Promise.race([
      timedClose,
      new Promise((_, reject) => setTimeout(() => reject(new Error("duration limit did not close")), 250)),
    ]);
  } finally {
    await close(proxy);
    await close(target);
  }
});

test("redacts credentials, tokens, and query secrets from logs", () => {
  const text = redactLogText(
    "Authorization: Bearer super-secret api_key=abc123 password=hunter2 https://allowed.test/?token=query-secret",
  );
  assert.doesNotMatch(text, /super-secret|abc123|hunter2|query-secret/);
  assert.match(text, /\[REDACTED\]/);
});
