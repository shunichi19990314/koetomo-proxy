"use strict";
/**
 * リレーモード(日本出口経由で地域ブロックを回避)のエンドツーエンドテスト。
 *
 * 構成(ループバックの別アドレスを使って「国」を模擬):
 *   proxy (localhost:8788)
 *     → relay (127.0.0.2:9997) …「日本サーバ」のつもり。RELAY_SOURCE_IP で発信元を 127.0.0.2 に固定
 *       → geo-mock 上流 (127.0.0.3:9999) … 127.0.0.2 からの接続だけ許可、それ以外は awselb 風 403
 *
 * 検証:
 *   - 直接アクセス(非日本IP)は 403 になること=地域ゲートが効いていること
 *   - リレー経由の HTML/JS が 200 になり、URL 書き換え・Cookie・CSP が機能すること
 *   - WebSocket がリレー(CONNECT トンネル)経由で中継されること
 *   - リレーの Basic 認証(407)と接続先許可リスト(403)が機能すること
 *   - /__status がリレー経路を反映して ✅ 判定になること
 *
 * 実行: node test/chain-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const httpm = require("http");
const { WebSocket } = require("ws");

const RELAY_IP = "127.0.0.2";
const RELAY_PORT = 9997;
const RELAY_TOKEN = "testtoken";
const GEO_IP = "127.0.0.3";
const GEO_PORT = 9999;
const PROXY_PORT = 8788;
const PROXY = `http://localhost:${PROXY_PORT}`;
const PROXY_HOST = `localhost:${PROXY_PORT}`;
const GEO_SELF = `http://${GEO_IP}:${GEO_PORT}`;

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

async function waitForHealth(url, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("not healthy: " + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function spawnNode(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = [];
  child.stdout.on("data", (d) => child.logs.push(d.toString()));
  child.stderr.on("data", (d) => child.logs.push(d.toString()));
  return child;
}

/** リレーに素の HTTP リクエストを投げてステータスコードを得る(認証/許可リスト検証用) */
function rawRelayRequest({ path: p, auth }) {
  return new Promise((resolve) => {
    const headers = auth ? { "proxy-authorization": "Basic " + Buffer.from("koetomo-relay:" + RELAY_TOKEN).toString("base64") } : {};
    const rq = httpm.request({ host: RELAY_IP, port: RELAY_PORT, path: p, method: "GET", headers }, (rr) => {
      rr.resume();
      resolve(rr.statusCode);
    });
    rq.on("error", () => resolve(0));
    rq.end();
  });
}

(async () => {
  // geo-mock 上流(このプロセス内)
  process.env.BIND_ADDR = GEO_IP;
  process.env.GEO_PORT = String(GEO_PORT);
  process.env.JP_IPS = RELAY_IP;
  const { startGeo } = require("./geo-mock-upstream");
  const geo = await startGeo();

  const relay = spawnNode(path.join(__dirname, "..", "relay", "relay.js"), {
    RELAY_PORT: String(RELAY_PORT),
    RELAY_BIND: RELAY_IP,
    RELAY_SOURCE_IP: RELAY_IP,
    RELAY_TOKEN,
    RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`,
    RELAY_PORTS: String(GEO_PORT),
    TLS_CERT: "/nonexistent/cert.pem",
    TLS_KEY: "/nonexistent/key.pem", // 証明書を置かない → プレーンHTTPモード(テスト用)
  });

  const proxy = spawnNode(path.join(__dirname, "..", "server.js"), {
    PORT: String(PROXY_PORT),
    UPSTREAM: GEO_SELF,
    RELAY_URL: `http://koetomo-relay:${RELAY_TOKEN}@${RELAY_IP}:${RELAY_PORT}`,
    PUBLIC_ORIGIN: "",
  });

  try {
    await waitForHealth(PROXY + "/__health");
    console.log(`chain: browser → ${PROXY} → relay ${RELAY_IP}:${RELAY_PORT} → geo-mock ${GEO_SELF}\n`);

    // ── 0. 地域ゲートが効いていることの確認(テストプロセス=非日本IPからの直撃) ──
    {
      const r = await fetch(GEO_SELF + "/");
      ok("直接アクセスは地域ゲートで 403", r.status === 403 && r.headers.get("server") === "awselb/2.0", r.status);
    }

    // ── 1. リレー経由で HTML が 200 + 各種URL書き換え ──
    {
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      const b = await r.text();
      ok("GET / → リレー経由で 200", r.status === 200, `${r.status} ${b.slice(0, 100)}`);
      ok("絶対URL 書き換え", b.includes(`http://${PROXY_HOST}/page`));
      ok("プロトコル相対 //host 書き換え", b.includes(`//${PROXY_HOST}/app.js`));
      ok("ws:// 書き換え", b.includes(`ws://${PROXY_HOST}/socket`));
      ok("エスケープ形式 書き換え", b.includes(`http:\\/\\/${PROXY_HOST}\\/api`));
      ok("URLエンコード形式 書き換え", b.includes(`http%3A%2F%2F${PROXY_HOST}%2Fcb`));
      ok("上流(geo)アドレスが本文に残らない", !b.includes(GEO_IP));
      const csp = r.headers.get("content-security-policy") || "";
      ok("CSP ヘッダ書き換え", csp.includes(PROXY_HOST) && !csp.includes(GEO_IP), csp);
      const sid = r.headers.getSetCookie().find((c) => c.startsWith("sid="));
      ok("Set-Cookie Domain 剥がし", sid && !/;\s*Domain=/i.test(sid), sid);
      ok("x-proxied-by", r.headers.get("x-proxied-by") === "koetomo-proxy");
    }

    // ── 2. JSON 書き換え / アプリ本来の 403 JSON 素通し ──
    {
      const r = await fetch(PROXY + "/api.json");
      const j = await r.json();
      ok("JSON 内 URL 書き換え", j.url === `http://${PROXY_HOST}/data` && j.ws === `ws://${PROXY_HOST}/socket`, JSON.stringify(j));
      const r2 = await fetch(PROXY + "/forbidden-json", { headers: { accept: "application/json" } });
      const b2 = await r2.text();
      ok("アプリ本来の 403 JSON は素通し(リレー経由)", r2.status === 403 && b2.includes('"error":"forbidden"'), b2);
    }

    // ── 3. WebSocket がリレーの CONNECT トンネル経由で中継される ──
    {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${PROXY_HOST}/socket`);
        let done = false;
        const finish = (cond, extra) => {
          if (done) return;
          done = true;
          ok("WS リレー経由 双方向中継", cond, extra);
          try { ws.terminate(); } catch {}
          resolve();
        };
        ws.on("open", () => ws.send("relay-hello"));
        ws.on("message", (m) => finish(m.toString() === "echo:relay-hello", m.toString()));
        ws.on("error", (e) => finish(false, e.message));
        ws.on("close", (c) => finish(false, "closed code=" + c));
        setTimeout(() => finish(false, "timeout"), 8000);
      });
    }

    // ── 4. リレーのセキュリティ(認証・許可リスト) ──
    {
      const r = await fetch(`http://${RELAY_IP}:${RELAY_PORT}/healthz`);
      ok("リレー /healthz(認証不要)", r.status === 200 && (await r.text()) === "ok");
      ok("認証なしリクエストは 407", (await rawRelayRequest({ path: GEO_SELF + "/", auth: false })) === 407);
      ok("許可外ホストは 403", (await rawRelayRequest({ path: "http://example.com/", auth: true })) === 403);
      ok("認証+許可ホストは 200", (await rawRelayRequest({ path: GEO_SELF + "/api.json", auth: true })) === 200);
    }

    // ── 5. /__status がリレー経路を反映 ──
    {
      const r = await fetch(PROXY + "/__status?format=json");
      const j = await r.json();
      ok("/__status relay.enabled = true", j.relay && j.relay.enabled === true && j.relay.url.includes(RELAY_IP), JSON.stringify(j.relay));
      ok("/__status 上流プローブ(リレー経由) 200", j.upstreamProbe && j.upstreamProbe.status === 200, JSON.stringify(j.upstreamProbe));
      ok("/__status 判定 ✅", j.verdict && j.verdict.ok === true, JSON.stringify(j.verdict));
      const r2 = await fetch(PROXY + "/__status", { headers: { accept: "text/html" } });
      const b2 = await r2.text();
      ok("/__status HTML にリレー表示", b2.includes("リレー経由") && b2.includes(RELAY_IP));
    }
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err);
    console.error("--- relay logs ---\n" + relay.logs.join(""));
    console.error("--- proxy logs ---\n" + proxy.logs.join(""));
  } finally {
    relay.kill("SIGTERM");
    proxy.kill("SIGTERM");
    geo.close();
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
