"use strict";
/*!
 * koetomo-proxy — 本家「声とも」(koetomo.fun) を Render 経由で開くフルリバースプロキシ
 * ============================================================================
 * 機能:
 *  - GET / POST / WebSocket を UPSTREAM (既定: https://koetomo.fun) へ転送
 *  - HTML / JS / CSS / JSON 内の絶対URL・wss://・URLエンコード形式・CSP ヘッダを
 *    自分(プロキシ)のオリジンへ自動書き換え
 *  - Set-Cookie の Domain 剥がし / Location 書き換え → ログイン状態をプロキシ側ドメインで維持
 *  - /__status : 「Render の発信IPが声ともに受け入れられるか」を判定する診断ページ(日本語)
 *  - /__health : Render ヘルスチェック用(即 200)
 *  - 上流 403 時は日本語のブロック説明ページを返す(アプリ本来の 403 JSON は素通し)
 *
 * 依存: ws のみ(HTTP は Node 20 組み込み fetch / undici を使用)
 * 環境変数: PORT, UPSTREAM, PUBLIC_ORIGIN(任意), TZ(任意)
 */

const http = require("http");
const { Readable, Transform } = require("stream");
const { WebSocket, WebSocketServer } = require("ws");

// ────────────────────────────── 設定 ──────────────────────────────

const UP = new URL(process.env.UPSTREAM || "https://koetomo.fun");
const UP_ORIGIN = UP.origin;            // https://koetomo.fun
const UP_HOST = UP.host;                // koetomo.fun (非標準ポートがあれば :port 込み)
const UP_WS_ORIGIN = UP_ORIGIN.replace(/^http/, "ws"); // wss://koetomo.fun
const PORT = Number(process.env.PORT || 10000);

const TEXT_MAX = 25 * 1024 * 1024;      // 書き換え用にバッファする応答ボディの上限
const REQ_BUF_MAX = 8 * 1024 * 1024;    // これ以下のリクエストボディはバッファ(content-length 正確)、超過分はストリーム転送
const STATUS_PROBE_TIMEOUT = 10_000;    // /__status の上流プローブ timeout (ms)
const IPINFO_TIMEOUT = 6_000;           // /__status の発信IP情報取得 timeout (ms)
const IPINFO_CACHE_TTL = 10 * 60_000;   // 発信IP情報のキャッシュ (ms)

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ────────────────────────────── 汎用ユーティリティ ──────────────────────────────

const log = (...args) => console.log(new Date().toISOString(), "[koetomo-proxy]", ...args);

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/** リクエストから見る「自分のオリジン」(例 https://koetomo-proxy.onrender.com) */
function publicOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

// ────────────────────────────── URL 書き換えエンジン ──────────────────────────────
//
// makeRewriter(書き換え元ホスト, ターゲットオリジン) → (text) => text
// 対応フォーマット:
//   1) https://HOST  http://HOST  wss://HOST  ws://HOST        (絶対URL)
//   2) https:\/\/HOST 等のバックスラッシュエスケープ形式       (JS 内の JSON 文字列など)
//   3) https%3A%2F%2FHOST 等の URL エンコード形式(1重/2重)
//   4) //HOST  %2F%2FHOST                                      (プロトコル相対)
//   ※ www.HOST も同一扱い。大文字小文字・16進数の大小文字を無視。

function makeRewriter(srcHost, targetOrigin) {
  const t = new URL(targetOrigin);
  const tHost = t.host;                             // koetomo-proxy.onrender.com / localhost:8787
  const tProto = t.protocol.replace(/:$/, "");      // https | http
  const H = escRe(srcHost);
  const WWW = `(?:www\\.)?${H}`;
  const B = String.raw`\\\/\\\/`;   // リテラルの \/\/ にマッチする正規表現ソース
  const BR = String.raw`\/\/`;      // 置換文字列としての \/\/ (そのまま出力される)

  const rules = [
    // ── 絶対URL(ws 系を先に処理) ──
    [`wss://${WWW}`, `wss://${tHost}`],
    [`ws://${WWW}`, `ws://${tHost}`],
    [`https://${WWW}`, `${tProto}://${tHost}`],
    [`http://${WWW}`, `${tProto}://${tHost}`],
    // ── バックスラッシュエスケープ形式 (JSON in JS) ──
    [`wss:${B}${WWW}`, `wss:${BR}${tHost}`],
    [`ws:${B}${WWW}`, `ws:${BR}${tHost}`],
    [`https:${B}${WWW}`, `https:${BR}${tHost}`],
    [`http:${B}${WWW}`, `http:${BR}${tHost}`],
    // ── URLエンコード(1重) ──
    [`wss%3A%2F%2F${WWW}`, `wss%3A%2F%2F${tHost}`],
    [`ws%3A%2F%2F${WWW}`, `ws%3A%2F%2F${tHost}`],
    [`https%3A%2F%2F${WWW}`, `${tProto}%3A%2F%2F${tHost}`],
    [`http%3A%2F%2F${WWW}`, `${tProto}%3A%2F%2F${tHost}`],
    // ── URLエンコード(2重) ──
    [`wss%253A%252F%252F${WWW}`, `wss%253A%252F%252F${tHost}`],
    [`ws%253A%252F%252F${WWW}`, `ws%253A%252F%252F${tHost}`],
    [`https%253A%252F%252F${WWW}`, `${tProto}%253A%252F%252F${tHost}`],
    [`http%253A%252F%252F${WWW}`, `${tProto}%253A%252F%252F${tHost}`],
    // ── プロトコル相対(スキーマ付きを消費した後に実行する順序が重要) ──
    [`//${WWW}`, `//${tHost}`],
    [`%2F%2F${WWW}`, `%2F%2F${tHost}`],
  ].map(([pattern, replacement]) => [new RegExp(pattern, "gi"), replacement]);

  return function rewrite(text) {
    let out = String(text);
    for (const [re, rep] of rules) out = out.replace(re, rep);
    return out;
  };
}

const _upCache = new Map();    // 応答用: 上流ホスト → プロキシオリジン
const _downCache = new Map();  // リクエストヘッダ用: プロキシホスト → 上流オリジン

/** 応答ボディ/ヘッダの書き換え(上流 → 自分) */
function upRewriter(origin) {
  if (!_upCache.has(origin)) _upCache.set(origin, makeRewriter(UP_HOST, origin));
  return _upCache.get(origin);
}

/** リクエストヘッダ(referer 等)の書き換え(自分 → 上流) */
function downRewriter(origin) {
  if (!_downCache.has(origin)) {
    let srcHost;
    try { srcHost = new URL(origin).host; } catch { srcHost = origin; }
    _downCache.set(origin, makeRewriter(srcHost, UP_ORIGIN));
  }
  return _downCache.get(origin);
}

// ────────────────────────────── ヘッダ処理 ──────────────────────────────

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

// 上流へ転送しないリクエストヘッダ(host/accept-encoding/content-length は fetch が再設定)
const REQ_DROP = new Set([
  ...HOP_BY_HOP, "host", "accept-encoding", "content-length",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "forwarded",
]);

// 値に URL が含まれ得る応答ヘッダ(書き換え対象)
const URL_HEADERS = new Set([
  "location", "link", "content-location", "refresh",
  "access-control-allow-origin",
  "content-security-policy", "content-security-policy-report-only", "x-webkit-csp",
]);

/** ブラウザ → 上流 のリクエストヘッダを構築(Origin/Referer は上流ネイティブに見えるよう補正) */
function buildUpstreamHeaders(req, origin) {
  const down = downRewriter(origin);
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (REQ_DROP.has(lk) || lk.startsWith("sec-websocket")) continue;
    h[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  // CSRF/Origin チェック対策: 上流から見た「自サイトからのリクエスト」の形に整える
  h["origin"] = UP_ORIGIN;
  if (h["referer"]) h["referer"] = down(h["referer"]);
  return h;
}

/** 上流レスポンスの Set-Cookie をプロキシ用ドメイン向けに修正(Domain 剥がし等) */
function fixSetCookies(upRes, origin) {
  let cookies = [];
  if (typeof upRes.headers.getSetCookie === "function") {
    cookies = upRes.headers.getSetCookie();
  } else {
    const sc = upRes.headers.get("set-cookie");
    if (sc) cookies = [sc];
  }
  const isHttp = new URL(origin).protocol === "http:"; // ローカル開発(http)向けの緩和
  return cookies.map((cookie) => {
    const parts = cookie.split(/;\s*/);
    const out = [parts[0]];
    for (const part of parts.slice(1)) {
      const eq = part.indexOf("=");
      const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? "" : part.slice(eq + 1).trim();
      if (name === "domain") continue; // Domain を剥がす → プロキシドメインの host-only cookie になる
      if (isHttp && name === "secure") continue; // http ローカルでは Secure を落とさないと保存されない
      if (isHttp && name === "samesite" && value.toLowerCase() === "none") {
        out.push("SameSite=Lax"); // SameSite=None は Secure 必須なので Lax にダウングレード
        continue;
      }
      out.push(part);
    }
    return out.join("; ");
  });
}

/** 上流レスポンスヘッダ → クライアント向けヘッダ配列([k, v] の羅列)を構築 */
function buildResponseHeaders(upRes, rewrite, origin, mode) {
  const headers = [];
  for (const [k, v] of upRes.headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "set-cookie" || lk === "content-encoding") continue;
    if (lk === "content-length") {
      if (mode === "rewrite") continue;             // 書き換え後に再計算
      if (mode === "nobody" || mode === "sse") continue;
      headers.push([k, v]);                         // バイナリ素通しの場合は正確なので維持
      continue;
    }
    if (URL_HEADERS.has(lk)) {
      headers.push([k, rewrite(v)]); // CSP / Location 等を自分のオリジンに書き換え
      continue;
    }
    headers.push([k, v]);
  }
  for (const c of fixSetCookies(upRes, origin)) headers.push(["set-cookie", c]);
  headers.push(["x-proxied-by", "koetomo-proxy"]);
  return headers;
}

// ────────────────────────────── ボディ判定 ──────────────────────────────

function isRewritableType(ct) {
  if (!ct) return false;
  const c = ct.toLowerCase();
  if (c.startsWith("text/event-stream")) return false; // SSE はストリーム書き換えで別処理
  if (c.startsWith("text/")) return true;              // html / css / js( text/* ) / plain / xml …
  return /(javascript|ecmascript|json|xml|svg|manifest|graphql)/.test(c);
}

/** Web ストリームを上限まで読む。超過時は overflow=true で reader を返す(残りは続きから読める) */
async function readLimited(webBody, limit) {
  const reader = webBody.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { chunks, size, overflow: false, reader };
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size > limit) return { chunks, size, overflow: true, reader };
  }
}

async function drainWrite(res, chunk) {
  if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
}

// ────────────────────────────── 日本語ページ共通 ──────────────────────────────

function htmlPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif;
         margin: 0; padding: 24px 16px; background: #f5f6f8; color: #1c1e21; line-height: 1.7; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e8e9ec; } .card { background: #1f2229 !important; } table td, table th { border-color: #33373f !important; } pre { background: #14161b !important; } }
  .wrap { max-width: 760px; margin: 0 auto; }
  .card { background: #fff; border-radius: 12px; padding: 24px 28px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 20px 0 8px; }
  .verdict { font-size: 18px; font-weight: 700; padding: 12px 16px; border-radius: 8px; margin: 12px 0; }
  .ok  { background: #e6f6ea; color: #13692c; } .bad { background: #fdeaea; color: #a01b1b; } .warn { background: #fff5e0; color: #8a5b00; }
  @media (prefers-color-scheme: dark) { .ok { background:#12331c; color:#7fdc9b; } .bad { background:#3a1518; color:#ff9d9d; } .warn { background:#3a2c10; color:#ffd97f; } }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #dfe1e6; padding: 6px 10px; text-align: left; word-break: break-all; }
  th { width: 34%; background: rgba(127,127,127,.07); font-weight: 600; }
  pre { background: #f0f1f4; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
  a { color: #0b62d0; } .muted { color: #6b7280; font-size: 12px; }
  ol li, ul li { margin: 4px 0; }
</style>
</head>
<body><div class="wrap">
${bodyHtml}
<p class="muted">koetomo-proxy v1.0 — 本家「声とも」(${escHtml(UP_ORIGIN)}) へのリバースプロキシ</p>
</div></body>
</html>`;
}

// ────────────────────────────── 上流 403 ブロック説明ページ ──────────────────────────────

function sendBlockedPage(req, res, upRes, origin) {
  const server = upRes.headers.get("server") || "(不明)";
  const body = htmlPage("403 — 声とも側でブロックされています", `
<div class="card">
  <h1>🚫 403 Forbidden — 上流「声とも」がこのプロキシのアクセスを拒否しました</h1>
  <div class="verdict bad">koetomo.fun のサーバ (${escHtml(server)}) が、Render の発信IPからのリクエストを HTTP 403 で拒否しています。<br>プロキシ自体は正常に動作しています。</div>
  <h2>考えられる原因</h2>
  <ul>
    <li>上流のファイアウォール / WAF が <b>データセンタ(クラウド)IP</b> をブロックしている</li>
    <li>上流が <b>日本国内など特定地域以外の IP</b> をブロックしている(Render のリージョンは既定でシンガポール)</li>
    <li>上流側で一時的な障害・メンテナンスが発生している</li>
  </ul>
  <h2>対処</h2>
  <ol>
    <li>まず <a href="/__status"><b>/__status 診断ページ</b></a> を開き、発信IP・国・ASN と判定を確認する</li>
    <li>Render ダッシュボードで <b>Manual Deploy</b> を実行 → 新的な発信IPが割り当てられ、通る場合がある</li>
    <li>サービスの <b>Region</b> を見直す(日本に最も近いのは Singapore)</li>
    <li>時間をおいて再試行する / 声とも側のお知らせ・ステータスを確認する</li>
    <li>自分の回線から直接 <a href="${escHtml(UP_ORIGIN)}" rel="noreferrer">koetomo.fun</a> を開ける場合は、ブロックがクラウドIP向けである可能性が高い</li>
  </ol>
  <h2>リクエスト詳細</h2>
  <table>
    <tr><th>パス</th><td>${escHtml(req.method + " " + req.url)}</td></tr>
    <tr><th>上流ステータス</th><td>${upRes.status}</td></tr>
    <tr><th>上流 Server</th><td>${escHtml(server)}</td></tr>
    <tr><th>プロキシのオリジン</th><td>${escHtml(origin)}</td></tr>
    <tr><th>時刻</th><td>${escHtml(nowJa())}</td></tr>
  </table>
  <p class="muted">※ アプリ自体が返す 403 JSON (API エラー) はこのページに置き換えず素通ししています。</p>
</div>`);
  res.writeHead(403, [
    ["content-type", "text/html; charset=utf-8"],
    ["content-length", String(Buffer.byteLength(body))],
    ["cache-control", "no-store"],
    ["x-koetomo-proxy-block", "upstream-403"],
  ]);
  res.end(body);
}

// ────────────────────────────── 502 (上流到達不能) ページ ──────────────────────────────

function sendBadGateway(req, res, origin, err) {
  const code = err?.cause?.code || err?.name || "Error";
  const msg = String(err?.message || err);
  const acceptJson = (req.headers.accept || "").includes("application/json") && !(req.headers.accept || "").includes("text/html");
  if (acceptJson) {
    const j = JSON.stringify({ error: "bad_gateway", upstream: UP_ORIGIN, code, message: msg });
    res.writeHead(502, [["content-type", "application/json; charset=utf-8"], ["content-length", String(Buffer.byteLength(j))]]);
    return res.end(j);
  }
  const body = htmlPage("502 — 上流に接続できません", `
<div class="card">
  <h1>⚠️ 502 Bad Gateway — 声ともに接続できませんでした</h1>
  <div class="verdict warn">Render から ${escHtml(UP_ORIGIN)} への接続が失敗しました。</div>
  <table>
    <tr><th>パス</th><td>${escHtml(req.method + " " + req.url)}</td></tr>
    <tr><th>エラー</th><td>${escHtml(code)} — ${escHtml(msg)}</td></tr>
    <tr><th>時刻</th><td>${escHtml(nowJa())}</td></tr>
  </table>
  <h2>対処</h2>
  <ul>
    <li>少し待って再読み込み(上流の一時的障害 / Render 無料プランのスリープ復帰直後など)</li>
    <li><a href="/__status">/__status 診断ページ</a> で上流到達性と発信IPを確認</li>
    <li>DNS 失敗 (ENOTFOUND) の場合は UPSTREAM 環境変数の設定を確認</li>
  </ul>
</div>`);
  res.writeHead(502, [["content-type", "text/html; charset=utf-8"], ["content-length", String(Buffer.byteLength(body))]]);
  res.end(body);
}

// ────────────────────────────── HTTP プロキシ本体 ──────────────────────────────

async function proxyHttp(req, res) {
  const started = Date.now();
  const origin = publicOrigin(req);
  const rewrite = upRewriter(origin);

  // origin-form ( /path?query ) のみ受け付ける(オープンプロキシ化の防止)
  if (!req.url.startsWith("/")) {
    res.writeHead(400, [["content-type", "text/plain; charset=utf-8"]]);
    return res.end("Bad request: only origin-form URLs are proxied.");
  }
  const target = UP_ORIGIN + req.url;

  // クライアントが切れたら上流 fetch も中断
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  // ── リクエストボディ(8MB までバッファ、超過分はストリーム) ──
  let bodyOpt = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > REQ_BUF_MAX) { overflow = true; break; }
    }
    if (overflow) {
      const merged = Readable.from((async function* () {
        for (const c of chunks) yield c;
        for await (const c of req) yield c;
      })());
      bodyOpt = { body: Readable.toWeb(merged), duplex: "half" };
    } else if (size > 0) {
      bodyOpt = { body: Buffer.concat(chunks, size) };
    }
  }

  let upRes;
  try {
    upRes = await fetch(target, {
      method: req.method,
      headers: buildUpstreamHeaders(req, origin),
      redirect: "manual", // 3xx は Location を書き換えてそのまま返す(外部 OAuth 等は素通し)
      signal: ac.signal,
      ...bodyOpt,
    });
  } catch (err) {
    if (res.headersSent || res.writableEnded) return res.destroy();
    if (err?.name === "AbortError") return; // クライアント側切断
    log(`upstream error ${req.method} ${req.url}:`, err?.cause?.code || err?.message);
    return sendBadGateway(req, res, origin, err);
  }

  const status = upRes.status;
  const upCt = upRes.headers.get("content-type") || "";

  // ── 上流 403: アプリ本来の JSON は素通し、それ以外(ELB/WAF の HTML 403)は日本語説明ページ ──
  if (status === 403 && !upCt.toLowerCase().includes("json")) {
    await upRes.body?.cancel().catch(() => {});
    log(`BLOCKED 403 ${req.method} ${req.url} (server=${upRes.headers.get("server") || "?"})`);
    return sendBlockedPage(req, res, upRes, origin);
  }

  const canHaveBody = status !== 204 && status !== 304 && req.method !== "HEAD" && upRes.body !== null;

  // ── ボディなし応答 ──
  if (!canHaveBody) {
    await upRes.body?.cancel().catch(() => {});
    res.writeHead(status, buildResponseHeaders(upRes, rewrite, origin, "nobody"));
    log(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`);
    return res.end();
  }

  const isSSE = upCt.toLowerCase().startsWith("text/event-stream");

  // ── SSE: チャンクごとに書き換えながらストリーム ──
  if (isSSE) {
    res.writeHead(status, buildResponseHeaders(upRes, rewrite, origin, "sse"));
    const t = new Transform({
      transform(chunk, _enc, cb) { cb(null, rewrite(chunk.toString("utf8"))); },
    });
    const src = Readable.fromWeb(upRes.body);
    src.on("error", () => { if (!res.writableEnded) res.destroy(); });
    src.pipe(t).pipe(res);
    log(`${req.method} ${req.url} -> ${status} (sse)`);
    return;
  }

  // ── 書き換え可能なテキスト(html/js/css/json/svg/xml…) ──
  if (isRewritableType(upCt)) {
    const { chunks, size, overflow, reader } = await readLimited(upRes.body, TEXT_MAX);
    if (!overflow) {
      const out = Buffer.from(rewrite(Buffer.concat(chunks, size).toString("utf8")), "utf8");
      const headers = buildResponseHeaders(upRes, rewrite, origin, "rewrite");
      headers.push(["content-length", String(out.byteLength)]);
      res.writeHead(status, headers);
      log(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms, ${size}B rewritten)`);
      return res.end(req.method === "HEAD" ? undefined : out);
    }
    // 上限超過の巨大テキスト: 書き換えを諦めて素通し(実運用ではほぼ発生しない)
    res.writeHead(status, buildResponseHeaders(upRes, rewrite, origin, "stream"));
    for (const c of chunks) await drainWrite(res, c);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await drainWrite(res, Buffer.from(value));
    }
    return res.end();
  }

  // ── バイナリ(画像/音声/動画/フォント/wasm…): 無加工でストリーム素通し ──
  res.writeHead(status, buildResponseHeaders(upRes, rewrite, origin, "stream"));
  const src = Readable.fromWeb(upRes.body);
  src.on("error", (e) => {
    if (e?.name !== "AbortError") log(`stream error ${req.url}:`, e?.message);
    if (!res.writableEnded) res.destroy();
  });
  src.pipe(res);
  res.on("finish", () => log(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms, stream)`));
}

// ────────────────────────────── WebSocket リレー ──────────────────────────────

function safeClose(ws, code, reason) {
  try {
    const c = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    let r;
    if (reason) {
      const buf = Buffer.from(String(reason), "utf8").subarray(0, 120);
      r = buf.toString("utf8"); // ws の close reason は 123 バイト以下
    }
    ws.close(c, r);
  } catch {
    try { ws.terminate(); } catch {}
  }
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 100 * 1024 * 1024 });

function relayWebSocket(req, client) {
  const origin = publicOrigin(req);
  const down = downRewriter(origin);
  const url = UP_WS_ORIGIN + req.url;

  // 上流へ転送するハンドシェイクヘッダ(ws ライブラリが予約ヘッダは自前で設定する)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "host" || lk === "accept-encoding" || lk.startsWith("sec-websocket")) continue;
    if (lk.startsWith("x-forwarded") || lk === "forwarded") continue;
    headers[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["origin"] = UP_ORIGIN;
  if (headers["referer"]) headers["referer"] = down(headers["referer"]);

  const proto = req.headers["sec-websocket-protocol"];
  const up = new WebSocket(url, proto ? proto.split(",").map((s) => s.trim()) : undefined, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
    maxPayload: 100 * 1024 * 1024,
  });

  // 上流が開くまでのクライアント発メッセージはキューに溜めて、開通後にまとめて転送
  const queue = [];
  let upOpen = false;

  client.on("message", (data, isBinary) => {
    if (!upOpen) return queue.push([data, isBinary]);
    if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
  });

  up.on("open", () => {
    upOpen = true;
    for (const [data, isBinary] of queue.splice(0)) up.send(data, { binary: isBinary });
    log(`ws opened ${req.url} -> ${UP_WS_ORIGIN}`);
  });

  up.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  up.on("error", (err) => {
    log(`ws upstream error ${req.url}:`, err.message);
    if (!upOpen) {
      // ハンドシェイク失敗(403 ブロック等) → クライアントに理由を伝えてクローズ
      safeClose(client, 4503, `upstream refused ws (${err.message.slice(0, 60)})`);
    }
    safeClose(client, 1011, "upstream ws error");
  });

  client.on("error", (err) => {
    log(`ws client error ${req.url}:`, err.message);
    safeClose(up, 1011, "client ws error");
  });

  up.on("close", (code, reason) => {
    upOpen = false;
    log(`ws upstream closed ${req.url} code=${code}`);
    safeClose(client, code, reason);
  });

  client.on("close", (code, reason) => {
    upOpen = false;
    log(`ws client closed ${req.url} code=${code}`);
    safeClose(up, code, reason);
  });
}

// ────────────────────────────── /__status 診断 ──────────────────────────────

const COUNTRY_JA = {
  US: "アメリカ", JP: "日本", SG: "シンガポール", DE: "ドイツ", GB: "イギリス", FR: "フランス",
  NL: "オランダ", IE: "アイルランド", CA: "カナダ", AU: "オーストラリア", IN: "インド",
  KR: "韓国", BR: "ブラジル", IT: "イタリア", ES: "スペイン", SE: "スウェーデン", HK: "香港", TW: "台湾",
};

function nowJa() {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: process.env.TZ || "Asia/Tokyo",
    dateStyle: "medium", timeStyle: "medium",
  }).format(new Date()) + " (" + (process.env.TZ || "Asia/Tokyo") + ")";
}

async function fetchJsonSafe(url, ms) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", "user-agent": UA_DESKTOP } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

let _egressCache = { at: 0, promise: null, data: null };

/** Render コンテナの「外向け(egress) IP」とその国・ASN を調べる(10分キャッシュ) */
function getEgressInfo() {
  const now = Date.now();
  if (_egressCache.data && now - _egressCache.at < IPINFO_CACHE_TTL) return Promise.resolve(_egressCache.data);
  if (_egressCache.promise) return _egressCache.promise;
  _egressCache.promise = (async () => {
    let info = null;
    const ipinfo = await fetchJsonSafe("https://ipinfo.io/json", IPINFO_TIMEOUT);
    if (ipinfo?.ip) {
      const m = String(ipinfo.org || "").match(/^(AS\d+)/);
      info = { ip: ipinfo.ip, country: ipinfo.country, city: ipinfo.city, region: ipinfo.region, org: ipinfo.org || null, asn: m ? m[1] : null, source: "ipinfo.io" };
    }
    if (!info) {
      const who = await fetchJsonSafe("https://ipwho.is/", IPINFO_TIMEOUT);
      if (who?.ip) {
        info = { ip: who.ip, country: who.country_code, city: who.city, region: who.region, org: who.connection?.org || null, asn: who.connection?.asn ? "AS" + who.connection.asn : null, source: "ipwho.is" };
      }
    }
    if (!info) {
      const ipify = await fetchJsonSafe("https://api.ipify.org?format=json", IPINFO_TIMEOUT);
      if (ipify?.ip) info = { ip: ipify.ip, country: null, city: null, region: null, org: null, asn: null, source: "ipify.org" };
    }
    _egressCache = { at: Date.now(), promise: null, data: info };
    return info;
  })();
  return _egressCache.promise;
}

/** 上流への疎通プローブ(ブラウザ風の GET /) */
async function probeUpstream() {
  const t0 = Date.now();
  try {
    const r = await fetch(UP_ORIGIN + "/", {
      redirect: "manual",
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT),
      headers: { "user-agent": UA_DESKTOP, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "ja,en-US;q=0.9" },
    });
    await r.body?.cancel().catch(() => {});
    return { ok: true, status: r.status, server: r.headers.get("server"), ms: Date.now() - t0, error: null };
  } catch (err) {
    return { ok: false, status: null, server: null, ms: Date.now() - t0, error: err?.cause?.code || err?.name || err?.message || "unknown" };
  }
}

function judgeUpstream(up, ip) {
  const ipText = ip ? `${ip.ip}${ip.country ? " / " + (COUNTRY_JA[ip.country] || ip.country) : ""}` : "取得失败";
  if (!up.ok) {
    return { level: "warn", icon: "⚠️", title: "上流に到達できません", ok: false,
      detail: `接続エラー (${up.error})。DNS 解決失敗・上流のダウン・タイムアウトのいずれかです。UPSTREAM 環境変数と声とも側の稼働状況を確認してください。` };
  }
  if (up.status === 403 || up.status === 401) {
    return { level: "bad", icon: "❌", title: `HTTP ${up.status} で拒否されています(IP ブロック)`, ok: false,
      detail: `声とも側のエッジ (${up.server || "?"}) が、この Render インスタンスの発信IP (${ipText}) からのアクセスを拒否しています。データセンタ IP ブロックまたは地域制限の可能性が高いです。Manual Deploy での IP 変更やリージョン変更 (Singapore) を試してください。` };
  }
  if (up.status >= 500) {
    return { level: "warn", icon: "⚠️", title: `上流がサーバエラー (HTTP ${up.status})`, ok: false,
      detail: "IP ブロックではありません(リクエストは届いています)。上流の一時的障害の可能性があります。少し待って再確認してください。" };
  }
  if (up.status >= 400) {
    return { level: "warn", icon: "⚠️", title: `HTTP ${up.status} が返りました`, ok: false,
      detail: "403/401 ではないため IP ブロックではありません。プロキシ経由の通常利用には影響しない可能性が高いです。" };
  }
  return { level: "ok", icon: "✅", title: `上流に受け入れられています (HTTP ${up.status}) — プロキシ利用可能`, ok: true,
    detail: `Render の発信IP (${ipText}) からのアクセスを koetomo.fun が正常に受け入れました。このプロキシ経由で声ともを利用できます。` };
}

async function statusPage(req, res) {
  const [up, ip] = await Promise.all([probeUpstream(), getEgressInfo()]);
  const verdict = judgeUpstream(up, ip);
  const origin = publicOrigin(req);

  const payload = {
    generatedAt: new Date().toISOString(),
    proxy: { origin, upstream: UP_ORIGIN },
    upstreamProbe: up,
    egressIp: ip,
    verdict: { ok: verdict.ok, title: verdict.title, detail: verdict.detail },
  };

  const url = new URL(req.url, origin);
  if (url.searchParams.get("format") === "json" || ((req.headers.accept || "").includes("application/json") && !(req.headers.accept || "").includes("text/html"))) {
    const j = JSON.stringify(payload, null, 2);
    res.writeHead(200, [["content-type", "application/json; charset=utf-8"], ["content-length", String(Buffer.byteLength(j))], ["cache-control", "no-store"]]);
    return res.end(j);
  }

  const countryJa = ip?.country ? `${COUNTRY_JA[ip.country] || ""} (${ip.country})`.trim() : "—";
  const body = htmlPage("声ともプロキシ 診断 (/__status)", `
<div class="card">
  <h1>🩺 声ともプロキシ 診断</h1>
  <p class="muted">「Render の発信IPが声ともに受け入れられるか」をその場で検査します。デプロイ完了 → 2分ほど待ってからこのページを開いてください。</p>
  <div class="verdict ${verdict.level}">${verdict.icon} ${escHtml(verdict.title)}</div>
  <p>${escHtml(verdict.detail)}</p>

  <h2>上流チェック</h2>
  <table>
    <tr><th>対象</th><td>${escHtml(UP_ORIGIN)}/</td></tr>
    <tr><th>HTTP ステータス</th><td>${up.ok ? up.status : "— (接続失敗)"}</td></tr>
    <tr><th>Server ヘッダ</th><td>${escHtml(up.server || "—")}</td></tr>
    <tr><th>応答時間</th><td>${up.ms} ms</td></tr>
    <tr><th>エラー</th><td>${escHtml(up.error || "なし")}</td></tr>
  </table>

  <h2>Render の発信IP (egress)</h2>
  <table>
    <tr><th>IP</th><td>${escHtml(ip?.ip || "—")}</td></tr>
    <tr><th>国</th><td>${escHtml(countryJa)}</td></tr>
    <tr><th>都市 / 地域</th><td>${escHtml(ip ? [ip.city, ip.region].filter(Boolean).join(" / ") || "—" : "—")}</td></tr>
    <tr><th>ASN / 事業者</th><td>${escHtml(ip ? [ip.asn, ip.org].filter(Boolean).join(" ") || "—" : "—")}</td></tr>
    <tr><th>情報源</th><td>${escHtml(ip?.source || "—")}</td></tr>
  </table>

  <h2>次のアクション</h2>
  <ul>
    <li>${verdict.ok
      ? `✅ そのまま <a href="/"><b>プロキシ経由で声ともを開く →</b></a>`
      : `❌ このままでは声ともを利用できません。Manual Deploy で IP を変える / リージョンを Singapore にする / 時間をおく、を試してください。`}</li>
    <li>生データ: <a href="/__status?format=json">/__status?format=json</a></li>
  </ul>

  <details><summary>生 JSON</summary><pre>${escHtml(JSON.stringify(payload, null, 2))}</pre></details>
  <p class="muted">検査時刻: ${escHtml(nowJa())}</p>
</div>`);
  res.writeHead(200, [["content-type", "text/html; charset=utf-8"], ["content-length", String(Buffer.byteLength(body))], ["cache-control", "no-store"]]);
  res.end(body);
}

// ────────────────────────────── サーバ起動 ──────────────────────────────

const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  res.on("error", () => {});
  if (u === "/__health") {
    res.writeHead(200, [["content-type", "text/plain"]]);
    return res.end("ok");
  }
  if (u === "/__status") {
    return statusPage(req, res).catch((err) => {
      log("status page error:", err.message);
      if (!res.headersSent) res.writeHead(500, [["content-type", "text/plain; charset=utf-8"]]);
      if (!res.writableEnded) res.end("status page error");
    });
  }
  return proxyHttp(req, res).catch((err) => {
    log("unhandled:", err);
    if (!res.headersSent) res.writeHead(500, [["content-type", "text/plain; charset=utf-8"]]);
    if (!res.writableEnded) res.end("Internal proxy error");
  });
});

// WebSocket アップグレード
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (client) => {
    try { relayWebSocket(req, client); }
    catch (err) { log("ws relay error:", err.message); try { client.terminate(); } catch {} }
  });
});
server.on("connect", (req, socket) => socket.destroy()); // CONNECT は不許可

// ゆるやかなタイムアウト設定(SSE / 長時間 WS を切らない)
server.headersTimeout = 65_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(PORT, () => {
  log(`listening on :${PORT}  ->  upstream ${UP_ORIGIN}`);
});

// Render のデプロイ切替時のグレースフルシャットダウン
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

module.exports = { server, upRewriter, makeRewriter };
