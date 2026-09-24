"use strict";
/**
 * koetomo-relay — 日本サーバ(Oracle Cloud 無料枠など)に置く「出口リレー」
 * =====================================================================
 * 声とも(koetomo.fun)は日本国外IPを 403 で拒否するため、Render(日本リージョン無し)からの
 * 直接接続は通りません。このリレーを日本のサーバで動かし、Render 側プロキシの RELAY_URL に
 * 指定することで、上流への接続だけを日本出口に置き換えます。
 *
 *   ブラウザ → Render(koetomo.onrender.com) → このリレー(日本) → koetomo.fun
 *
 * 特徴:
 *  - 依存パッケージゼロ(Node 標準のみ)。npm install 不要
 *  - HTTPS(CONNECT トンネル)+ 絶対形式 HTTP リクエスト + Upgrade(WS) 転送に対応
 *  - Basic 認証(RELAY_TOKEN)+ 接続先ホストの許可リスト(RELAY_ALLOW)で踏み台化を防止
 *  - TLS: /etc/koetomo-relay/{cert,key}.pem があれば HTTPS、無ければ HTTP(ローカルテスト用)
 *
 * 環境変数:
 *   RELAY_PORT   待ち受けポート(既定 8443)
 *   RELAY_BIND   バインドアドレス(既定 0.0.0.0)
 *   RELAY_TOKEN  Basic 認証パスワード(未設定なら認証オフ=ローカルテスト用)
 *   RELAY_ALLOW  接続許可ホスト(カンマ区切り、後方一致。既定 koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org)
 *   TLS_CERT / TLS_KEY  証明書・鍵のパス(既定 /etc/koetomo-relay/cert.pem, key.pem)
 */

const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

const PORT = Number(process.env.RELAY_PORT || 8443);
const BIND = process.env.RELAY_BIND || "0.0.0.0";
const TOKEN = process.env.RELAY_TOKEN || "";
const ALLOW = (process.env.RELAY_ALLOW || "koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// 外向き接続のソースIP(テストで擬似「日本IP」を演出する際や、多層NIC環境で固定したい場合に使用)
const SOURCE_IP = process.env.RELAY_SOURCE_IP || ((BIND !== "0.0.0.0" && BIND !== "::") ? BIND : undefined);
// CONNECT/転送を許可するポート(既定 80,443)
const ALLOWED_PORTS = new Set(String(process.env.RELAY_PORTS || "80,443").split(",").map((s) => Number(s.trim())));
const TLS_CERT = process.env.TLS_CERT || "/etc/koetomo-relay/cert.pem";
const TLS_KEY = process.env.TLS_KEY || "/etc/koetomo-relay/key.pem";

const log = (...a) => console.log(new Date().toISOString(), "[koetomo-relay]", ...a);

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOW.some((suffix) => h === suffix || h.endsWith("." + suffix));
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Proxy-Authorization: Basic <base64(user:pass)> の pass 部分を RELAY_TOKEN と比較 */
function authorized(req) {
  if (!TOKEN) return true; // 認証オフ(ローカルテスト用)
  const h = req.headers["proxy-authorization"] || "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let pass;
  try {
    pass = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
  } catch { return false; }
  return timingSafeEqualStr(pass, TOKEN);
}

function deny(res, code, msg) {
  const body = msg + "\n";
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body), "proxy-connection": "close" });
  res.end(body);
}

function pipePair(a, b) {
  a.pipe(b);
  b.pipe(a);
  const cleanup = () => { a.destroy(); b.destroy(); };
  a.on("error", cleanup);
  b.on("error", cleanup);
  a.on("close", cleanup);
  b.on("close", cleanup);
}

/** 絶対形式 HTTP リクエストの上流転送(Upgrade=WebSocket にも対応) */
function forwardHttp(req, clientSocket, clientHead, res) {
  const u = new URL(req.url);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!hostAllowed(u.hostname)) return deny(res, 403, "403 destination not allowed by relay policy");
  if (u.protocol === "https:") {
    // https の絶対形式は本来 CONNECT で来る。来た場合は拒否して簡潔に。
    return deny(res, 400, "400 use CONNECT for https targets");
  }
  if (!ALLOWED_PORTS.has(port)) return deny(res, 403, "403 port not allowed");

  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i].toLowerCase();
    if (k === "proxy-authorization" || k === "proxy-connection") continue;
    headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  }
  headers["host"] = u.host;

  const upReq = http.request({ hostname: u.hostname, port, method: req.method, path: u.pathname + u.search, headers, localAddress: SOURCE_IP });

  // WebSocket 等の Upgrade 転送
  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ""}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      if (upRes.rawHeaders[i].toLowerCase() === "transfer-encoding") continue;
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead && upHead.length) clientSocket.write(upHead);
    if (clientHead && clientHead.length) upSocket.write(clientHead);
    pipePair(upSocket, clientSocket);
    log(`upgrade relayed ${u.host}${u.pathname} (${upRes.statusCode})`);
  });

  upReq.on("response", (upRes) => {
    res.writeHead(upRes.statusCode, upRes.rawHeaders);
    upRes.pipe(res);
  });
  upReq.on("error", (e) => {
    log(`forward error ${u.host}: ${e.message}`);
    if (!res.headersSent) deny(res, 502, "502 relay upstream error");
    else res.destroy();
  });
  req.pipe(upReq);
}

function onRequest(req, res) {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (!authorized(req)) {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="koetomo-relay"', "content-type": "text/plain" });
    return res.end("407 Proxy Authentication Required\n");
  }
  if (req.url.startsWith("/")) {
    // origin-form はこのリレー自体に向けたリクエスト(healthz 以外は無効)
    return deny(res, 400, "400 this is a forward proxy; use absolute-form or CONNECT");
  }
  return forwardHttp(req, req.socket, null, res);
}

function onConnect(req, clientSocket, head) {
  if (!authorized(req)) {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"koetomo-relay\"\r\n\r\n");
    return;
  }
  const [hostname, portStr] = req.url.split(":");
  const port = Number(portStr || 443);
  if (!hostAllowed(hostname)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    log(`CONNECT denied (allowlist): ${req.url}`);
    return;
  }
  if (!ALLOWED_PORTS.has(port)) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const up = net.connect({ host: hostname, port, localAddress: SOURCE_IP }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) up.write(head);
    pipePair(up, clientSocket);
  });
  up.on("error", (e) => {
    log(`CONNECT error ${req.url}: ${e.message}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  clientSocket.on("error", () => up.destroy());
}

// ── 起動 ──
let server;
if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, onRequest);
  log("TLS mode (cert found)");
} else {
  server = http.createServer(onRequest);
  log("PLAIN HTTP mode (no cert — local testing only!)");
}
server.on("connect", onConnect);
server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} });

server.listen(PORT, BIND, () => {
  log(`listening on ${BIND}:${PORT} | auth: ${TOKEN ? "ON" : "OFF"} | allow: ${ALLOW.join(", ")}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
