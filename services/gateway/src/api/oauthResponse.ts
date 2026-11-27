import type { FastifyReply, FastifyRequest } from "fastify";

export function sendOAuthSuccess(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { connector: "Gmail" | "Google Calendar"; payload: Record<string, unknown> },
) {
  const acceptsHtml = String(request.headers.accept ?? "").toLowerCase().includes("text/html");
  if (!acceptsHtml) return reply.send(input.payload);
  reply
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    .type("text/html; charset=utf-8");
  return reply.send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perskop bağlantısı tamamlandı</title><style>body{margin:0;background:#0b1020;color:#e8ecff;font:16px system-ui;display:grid;min-height:100vh;place-items:center}.card{max-width:520px;margin:24px;padding:32px;border:1px solid #2a3558;border-radius:18px;background:#121a31}h1{font-size:24px}p{color:#b7c1dd;line-height:1.6}.ok{font-size:40px}</style></head>
<body><main class="card"><div class="ok">✓</div><h1>${input.connector} bağlandı</h1><p>Perskop bağlantıyı algıladı. Bu sekmeyi kapatıp uygulamaya dönebilirsin; senkronizasyon otomatik başlayacak.</p></main></body></html>`);
}
