"use strict";
/**
 * テスト用の偽「声とも」サーバ。
 * 自分自身のオリジン (http://127.0.0.1:9999) を含む HTML/JSON/CSP/Cookie/WS/SSE を提供し、
 * プロキシがこれを自分のオリジンに書き換えられるかを検証できるようにする。
 */
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.FAKE_PORT || 9999);
const SELF = `http://127.0.0.1:${PORT}`;

const HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>声とも(偽)</title>
<link rel="stylesheet" href="${SELF}/style.css">
<script src="//127.0.0.1:${PORT}/app.js"></script>
</head><body>
<a href="${SELF}/page">リンク</a>
<img src="//127.0.0.1:${PORT}/img.png">
<script>
  const API = "http:\\/\\/127.0.0.1:${PORT}\\/api";
  const WS_URL = "ws://127.0.0.1:${PORT}/socket";
  const CALLBACK = "http%3A%2F%2F127.0.0.1:${PORT}%2Fcb";
</script>
</body></html>`;

function startFake(port = PORT) {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];

    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader(
        "content-security-policy",
        `default-src 'self' ${SELF}; connect-src 'self' ws://127.0.0.1:${port || PORT}; img-src *; frame-ancestors 'none'`
      );
      res.setHeader("set-cookie", [
        `sid=abc123; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None`,
        `pref=ja; Path=/`,
      ]);
      return res.end(HTML);
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: `${SELF}/after` });
      return res.end();
    }
    if (path === "/redirect-ext") {
      res.writeHead(302, { location: "https://example.com/cb" });
      return res.end();
    }
    if (path === "/api.json") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: true, url: `${SELF}/data`, ws: `ws://127.0.0.1:${PORT}/socket` }));
    }
    if (path === "/echo") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("content-length", String(body.length));
        res.end(body);
      });
      return;
    }
    if (path === "/needscookie") {
      const ok = String(req.headers.cookie || "").includes("sid=abc123");
      res.setHeader("content-type", "application/json");
      res.statusCode = ok ? 200 : 401;
      return res.end(JSON.stringify({ authed: ok }));
    }
    if (path === "/binary") {
      const buf = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251));
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", String(buf.length));
      return res.end(buf);
    }
    if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`data: {"n":${n},"u":"${SELF}/e${n}"}\n\n`);
        if (n >= 3) { clearInterval(t); res.end(); }
      }, 30);
      return;
    }
    if (path === "/forbidden-html") {
      res.setHeader("server", "awselb/2.0");
      res.setHeader("content-type", "text/html");
      res.statusCode = 403;
      return res.end("<html><head><title>403 Forbidden</title></head><body>403</body></html>");
    }
    if (path === "/forbidden-json") {
      res.setHeader("content-type", "application/json");
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: "forbidden", code: 403 }));
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const wss = new WebSocketServer({ server, path: "/socket" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send("echo:" + data.toString()));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startFake, SELF, PORT };

if (require.main === module) {
  startFake().then(() => console.log("fake upstream on", SELF));
}
