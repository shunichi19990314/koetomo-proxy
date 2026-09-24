"use strict";
/**
 * スモークテスト: 偽上流 (127.0.0.1:9999) + プロキシ (localhost:8787) を起動し、
 * URL 書き換え / Cookie / リダイレクト / バイナリ / SSE / WebSocket / 403 ページ /
 * /__status / オープンプロキシ防止 を一括検証する。
 *
 * 実行: node test/smoke.js  (または npm test)
 */
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
const { WebSocket } = require("ws");
const { startFake, SELF, PORT: FAKE_PORT } = require("./fake-upstream");

const PROXY_PORT = 8787;
const PROXY = `http://localhost:${PROXY_PORT}`;
const PROXY_HOST = `localhost:${PROXY_PORT}`;

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : ""));
  }
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("proxy did not become healthy: " + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  await startFake(FAKE_PORT);
  console.log("fake upstream:", SELF);

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, UPSTREAM: SELF, PORT: String(PROXY_PORT), PUBLIC_ORIGIN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proxyLogs = [];
  child.stdout.on("data", (d) => proxyLogs.push(d.toString()));
  child.stderr.on("data", (d) => proxyLogs.push(d.toString()));

  try {
    await waitForHealth(PROXY + "/__health");
    console.log("proxy:", PROXY, "(upstream =", SELF + ")\n");

    // ── 1. HTML 書き換え(絶対URL / プロトコル相対 / ws / エスケープ / エンコード / CSP / Cookie) ──
    {
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      const body = await r.text();
      ok("GET / → 200", r.status === 200, r.status);
      ok("絶対URL 書き換え", body.includes(`http://${PROXY_HOST}/page`));
      ok("プロトコル相対 //host 書き換え", body.includes(`//${PROXY_HOST}/app.js`));
      ok("ws:// 書き換え", body.includes(`ws://${PROXY_HOST}/socket`));
      ok("バックスラッシュエスケープ形式 書き換え", body.includes(`http:\\/\\/${PROXY_HOST}\\/api`), body.match(/const API.*$/m)?.[0]);
      ok("URLエンコード形式 書き換え", body.includes(`http%3A%2F%2F${PROXY_HOST}%2Fcb`));
      ok("上流オリジンが本文に残っていない", !body.includes("127.0.0.1"));

      const csp = r.headers.get("content-security-policy") || "";
      ok("CSP ヘッダ書き換え", csp.includes(PROXY_HOST) && !csp.includes("127.0.0.1"), csp);

      const cookies = r.headers.getSetCookie();
      const sid = cookies.find((c) => c.startsWith("sid="));
      ok("Set-Cookie: Domain 剥がし", sid && !/;\s*Domain=/i.test(sid), sid);
      ok("Set-Cookie: http ターゲットで Secure 除去", sid && !/;\s*Secure/i.test(sid), sid);
      ok("Set-Cookie: SameSite=None → Lax (http)", sid && /SameSite=Lax/i.test(sid), sid);
      ok("Set-Cookie: HttpOnly 維持", sid && /HttpOnly/i.test(sid), sid);
      ok("Set-Cookie: 2枚目も転送", cookies.some((c) => c.startsWith("pref=ja")));
      ok("x-proxied-by ヘッダ", r.headers.get("x-proxied-by") === "koetomo-proxy");
    }

    // ── 2. リダイレクト Location 書き換え ──
    {
      const r = await fetch(PROXY + "/redirect", { redirect: "manual" });
      ok("302 ステータス維持", r.status === 302, r.status);
      ok("Location を自オリジンへ書き換え", r.headers.get("location") === `http://${PROXY_HOST}/after`, r.headers.get("location"));
      const r2 = await fetch(PROXY + "/redirect-ext", { redirect: "manual" });
      ok("外部 Location (OAuth 等) は素通し", r2.headers.get("location") === "https://example.com/cb", r2.headers.get("location"));
    }

    // ── 3. JSON ボディ書き換え ──
    {
      const r = await fetch(PROXY + "/api.json");
      const j = await r.json();
      ok("JSON 内 URL 書き換え", j.url === `http://${PROXY_HOST}/data` && j.ws === `ws://${PROXY_HOST}/socket`, JSON.stringify(j));
    }

    // ── 4. POST 転送 + クエリ + Cookie 転送 ──
    {
      const r = await fetch(PROXY + "/echo?q=1", { method: "POST", body: "hello-声とも", headers: { "content-type": "text/plain; charset=utf-8" } });
      const t = await r.text();
      ok("POST ボディ転送 (UTF-8)", r.status === 200 && t === "hello-声とも", t);
      const r2 = await fetch(PROXY + "/needscookie", { headers: { cookie: "sid=abc123" } });
      const j2 = await r2.json();
      ok("Cookie 転送 (ログイン状態)", r2.status === 200 && j2.authed === true, JSON.stringify(j2));
    }

    // ── 5. バイナリ素通し ──
    {
      const r = await fetch(PROXY + "/binary");
      const got = Buffer.from(await r.arrayBuffer());
      const want = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251));
      ok("バイナリ 100KB 完全一致", r.status === 200 && got.equals(want), `${got.length} bytes`);
    }

    // ── 6. SSE ストリーム書き換え ──
    {
      const r = await fetch(PROXY + "/events");
      const t = await r.text();
      ok("SSE データ行の URL 書き換え", t.includes(`http://${PROXY_HOST}/e1`) && !t.includes("127.0.0.1"), t.slice(0, 160));
    }

    // ── 7. 上流 403: HTML → 日本語説明ページ / JSON → 素通し ──
    {
      const r = await fetch(PROXY + "/forbidden-html", { headers: { accept: "text/html" } });
      const b = await r.text();
      ok("403 HTML → 日本語ブロック説明ページ", r.status === 403 && b.includes("ブロック") && b.includes("/__status"), b.slice(0, 120));
      ok("x-koetomo-proxy-block ヘッダ", r.headers.get("x-koetomo-proxy-block") === "upstream-403");
      const r2 = await fetch(PROXY + "/forbidden-json", { headers: { accept: "application/json" } });
      const b2 = await r2.text();
      ok("アプリ本来の 403 JSON は素通し", r2.status === 403 && b2.includes('"error":"forbidden"'), b2);
    }

    // ── 8. /__health と /__status ──
    {
      const r = await fetch(PROXY + "/__health");
      ok("/__health → ok", r.status === 200 && (await r.text()) === "ok");
      const r2 = await fetch(PROXY + "/__status?format=json");
      const j = await r2.json();
      ok("/__status JSON 200", r2.status === 200);
      ok("/__status 上流プローブ成功", j.upstreamProbe && j.upstreamProbe.status === 200, JSON.stringify(j.upstreamProbe));
      ok("/__status 判定 ✅", j.verdict && j.verdict.ok === true, JSON.stringify(j.verdict));
      if (j.egressIp && j.egressIp.ip) ok("/__status 発信IP取得", true, j.egressIp.ip + " (" + j.egressIp.source + ")");
      else console.log("  NOTE  発信IP情報はサンドボックスからの外部API到達不可のため未取得(本番 Render では取得できます)");
      const r3 = await fetch(PROXY + "/__status", { headers: { accept: "text/html" } });
      const b3 = await r3.text();
      ok("/__status HTML ページ(日本語)", r3.status === 200 && b3.includes("診断") && b3.includes("発信IP"));
    }

    // ── 9. WebSocket リレー(接続直後メッセージのキューイング含む) ──
    {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${PROXY_HOST}/socket`);
        const got = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          ok("WS 双方向リレー (echo)", got.includes("echo:hello") && got.includes("echo:immediate"), JSON.stringify(got));
          try { ws.terminate(); } catch {}
          resolve();
        };
        ws.on("open", () => {
          ws.send("immediate"); // 上流 ws が開く前に送ってもキューされて届くはず
          ws.send("hello");
        });
        ws.on("message", (m) => {
          got.push(m.toString());
          if (got.length >= 2) finish();
        });
        ws.on("error", (e) => { ok("WS エラーなし", false, e.message); resolve(); });
        setTimeout(finish, 5000);
      });
    }

    // ── 10. オープンプロキシ防止(absolute-form リクエストを拒否) ──
    {
      await new Promise((resolve) => {
        const sock = net.connect(PROXY_PORT, "127.0.0.1", () => {
          sock.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
        });
        let data = "";
        sock.on("data", (d) => (data += d.toString()));
        sock.on("close", () => {
          ok("absolute-form は 400 で拒否", data.startsWith("HTTP/1.1 400"), data.split("\r\n")[0]);
          resolve();
        });
        sock.on("error", (e) => { ok("absolute-form は 400 で拒否", false, e.message); resolve(); });
      });
    }
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err);
    console.error(proxyLogs.join(""));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
