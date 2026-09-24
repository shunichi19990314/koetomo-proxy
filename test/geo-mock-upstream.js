"use strict";
/**
 * 「日本国外IPを403で拒否する声とも」を模擬するテスト用上流サーバ。
 * JP_IPS(既定 127.0.0.2)からの接続だけ 200 を返し、それ以外は awselb 風 403 を返す。
 * BIND_ADDR(既定 127.0.0.3)/ PORT(既定 9999)で待ち受ける。
 * ルート内容は fake-upstream.js と同じ(rewrite 検証用)。
 */
const http = require("http");
const { WebSocketServer } = require("ws");

const BIND_ADDR = process.env.BIND_ADDR || "127.0.0.3";
const PORT = Number(process.env.GEO_PORT || 9999);
const JP_IPS = new Set((process.env.JP_IPS || "127.0.0.2").split(","));
const SELF = `http://${BIND_ADDR}:${PORT}`;

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>声とも(geo模拟)</title>
<script src="//${BIND_ADDR}:${PORT}/app.js"></script>
</head><body>
<a href="${SELF}/page">リンク</a>
<script>
  const API = "http:\\/\\/${BIND_ADDR}:${PORT}\\/api";
  const WS_URL = "ws://${BIND_ADDR}:${PORT}/socket";
  const CALLBACK = "http%3A%2F%2F${BIND_ADDR}:${PORT}%2Fcb";
</script>
</body></html>`;
}

function forbidden(res) {
  res.statusCode = 403;
  res.setHeader("server", "awselb/2.0");
  res.setHeader("content-type", "text/html");
  res.end("<html><head><title>403 Forbidden</title></head><body>geo blocked</body></html>");
}

function startGeo() {
  const server = http.createServer((req, res) => {
    const peer = req.socket.remoteAddress;
    // 日本IP以外は問答無用で 403(本物の koetomo.fun の挙動を模擬)
    if (!JP_IPS.has(peer)) return forbidden(res);

    const path = req.url.split("?")[0];
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", `default-src 'self' ${SELF}; connect-src 'self' ws://${BIND_ADDR}:${PORT}; img-src *`);
      res.setHeader("set-cookie", [`sid=geo123; Domain=${BIND_ADDR}; Path=/; Secure; HttpOnly; SameSite=None`]);
      return res.end(buildHtml());
    }
    if (path === "/api.json") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: true, url: `${SELF}/data`, ws: `ws://${BIND_ADDR}:${PORT}/socket` }));
    }
    if (path === "/forbidden-json") {
      res.setHeader("content-type", "application/json");
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: "forbidden", code: 403 }));
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const peer = socket.remoteAddress;
    if (!JP_IPS.has(peer)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d) => ws.send("echo:" + d.toString()));
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND_ADDR, () => {
      console.log(`geo-mock upstream on ${SELF} (JP IPs: ${[...JP_IPS].join(",")})`);
      resolve(server);
    });
  });
}

module.exports = { startGeo, SELF, PORT, BIND_ADDR, JP_IPS };

if (require.main === module) startGeo();
