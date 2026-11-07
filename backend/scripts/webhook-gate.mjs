// A tiny door for testing PayPal webhooks through a free tunnel.
// PaidLoop has no login, so the tunnel must never show the owner screens. This door lets exactly one
// request through: POST /api/paypal/webhook. Everything else gets 404. PayPal's signature is still checked by the app.
//
// Run:  node scripts/webhook-gate.mjs [door port] [app port]      (defaults 8010 and 8000)
import { createServer, request } from "node:http";

const DOOR = Number(process.argv[2] ?? 8010);
const APP = Number(process.argv[3] ?? 8000);
const MAX_BYTES = 200_000;

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/paypal/webhook") {
    res.writeHead(404, { "content-type": "application/json" }).end('{"detail":"Not found."}');
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const forward = request({ host: "127.0.0.1", port: APP, path: req.url, method: "POST", headers: { ...req.headers, host: `127.0.0.1:${APP}`, "content-length": body.length } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on("error", () => res.writeHead(502).end());
    forward.end(body);
    console.log(`${new Date().toISOString()} webhook received, ${body.length} bytes`);
  });
}).listen(DOOR, "127.0.0.1", () => console.log(`Webhook door on http://127.0.0.1:${DOOR}, forwarding to the app on ${APP}`));
