# koetomo-proxy — 本家「声とも」を Render 経由で開くフルリバースプロキシ

[声とも (koetomo.fun)](https://koetomo.fun) への全リクエストを肩代わりするリバースプロキシです。
Render の無料 Web サービスとしてデプロイし、ブラウザでは `https://koetomo-proxy.onrender.com` を開くだけで本家の声ともが動きます。

## 機能

| 機能 | 内容 |
|---|---|
| フルリバースプロキシ | GET / POST / WebSocket を koetomo.fun に転送。HTML・JS・CSS・JSON 内の絶対URL・`wss://`・URLエンコード形式・CSP ヘッダまで自分のオリジンに自動書き換え |
| Cookie / リダイレクト対応 | `Set-Cookie` の `Domain` 剥がし、`Location` 書き換え → ログイン状態がプロキシ側ドメインで維持される設計 |
| `/__status` 診断 | デプロイ後 2 分で「Render の IP が声ともに受け入れられるか」が判定できる(上流ステータス + 発信IP・国・ASN + 日本語の判定文) |
| ブロック説明ページ | 上流 403 時は謎のエラーではなく、原因と対処を書いた日本語ページを返す(アプリ本来の 403 JSON は素通し) |
| `render.yaml` | Blueprint で **New + → Blueprint → リポジトリ選択** だけで `https://koetomo-proxy.onrender.com` が完成 |

## デプロイ手順(Render)

1. このフォルダを GitHub リポジトリに push する
2. Render ダッシュボード → **New +** → **Blueprint** → そのリポジトリを選択
3. 完了。`https://koetomo-proxy.onrender.com` が生まれます
   - サービス名 `koetomo-proxy` が既に世界中の誰かに使われていた場合、Render が自動で后缀を付けた URL になります(動作は同じ)
4. **デプロイ完了 → 約2分後に [`/__status`](https://koetomo-proxy.onrender.com/__status) を開く** ← 最重要
   - ✅ ならそのまま `/` を開いて声ともを利用できます
   - ❌ (403) なら下の「403 が出たとき」へ

> リージョンは `render.yaml` で **Singapore**(声とも=AWS東京に地理的に最寄り)に設定済みです。
> 無料プランは 15 分無アクセスでスリープし、復帰時の初回アクセスに数十秒かかります。

## /__status の読み方

| 項目 | 意味 |
|---|---|
| HTTP ステータス / Server | 声とも側のエッジサーバが Render の IP をどう扱ったか(例: `403` + `awselb/2.0` = AWS ロードバランサ段階で拒否) |
| 発信IP・国・ASN | この Render インスタンスが「外から見える IP」。データセンタ IP かどうかの判断材料 |
| 判定文 | ✅ 受け入れ / ❌ IP ブロック / ⚠️ 到達不能・上流エラー、を日本語で表示 |

JSON が欲しければ `/__status?format=json`。

## 403 が出たとき

声とも側(現状 AWS ELB)がクラウド/データセンタ IP や特定地域をブロックしている場合、プロキシ自体は正常でも上流が 403 を返します。このときプロキシは日本語の説明ページを表示します。対処の優先順:

1. **Manual Deploy を回す** — Render のインスタンス再作成で発信 IP が変わり、通る場合があります(数回試す価値あり)
2. **リージョンを変える** — `render.yaml` の `region:` は Singapore 既定。Oregon / Ohio / Virginia / Frankfurt も試せます(既存サービスのリージョン変更は不可 → 新規作成)
3. **時間帯を変える** — 上流の負荷・メンテナンス由来の一時的 403 の可能性
4. 自分自身の回線から直接 koetomo.fun を開けるか確認し、「クラウド IP 狙い撃ちのブロック」か「広域の障害/制限」かを切り分け

## ローカル開発・テスト

```bash
npm install
npm start              # http://localhost:10000 → https://koetomo.fun へのプロキシとして起動

# 自動テスト(偽上流を立てて URL 書き換え/Cookie/WS/SSE/403/診断を全 33 項目検証)
npm test
```

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート(Render が自動設定) |
| `UPSTREAM` | `https://koetomo.fun` | プロキシ先 |
| `PUBLIC_ORIGIN` | (リクエストの Host から自動判定) | URL 書き換えに使う自分のオリジンを固定したい場合のみ設定 |
| `TZ` | `Asia/Tokyo` | 診断ページの時刻表示用 |

## 仕組みメモ

- HTTP 転送は Node 20 組み込み `fetch` (undici)。上流の gzip/br は自動解凍してから書き換え・再送するため `Content-Encoding`/`Content-Length` は正しく再計算されます
- 書き換え対応フォーマット: `https://` `http://` `wss://` `ws://` / `\/\/` エスケープ形式 / `%3A%2F%2F`・`%253A%252F%252F` エンコード形式 / プロトコル相対 `//host`(すべて `www.` 付きも含む、大小文字無視)
- `Origin`・`Referer` は上流ネイティブの値に補正してから転送(CSRF/Origin チェック対策)
- 3xx は `manual` で受け、`Location` が声とも向きなら自オリジンへ書き換え、外部(OAuth 等)なら素通し
- WebSocket は `upgrade` を捕捉し `ws` で上流へブリッジ。上流接続確立前のクライアント送信はキューして開通後にまとめて転送
- SSE (`text/event-stream`) はチャンク単位で書き換えながらストリーム
- バイナリ(画像/音声/フォント等)は無加工・ストリーム素通し。テキストは 25MB までバッファ書き換え
- absolute-form (`GET http://example.com/`) は 400 で拒否 → オープンプロキシ化を防止

## 制限・注意

- 対象は `koetomo.fun` / `www.koetomo.fun` のみ。他サブドメイン(`cdn.` など)が使われている場合は書き換え対象外です(現状 DNS 上 www は解決しません)
- 上流が 403 でクラウド IP を弾いている限り、このプロキシは魔法では解けません(`/__status` で事実が確認できる、という設計です)
- Render 無料プラン: スリープあり・月 512MB アウトバウンド等の制約あり。音声系アプリは通信量が多くなりがちなので、ヘビーユースは有料プラン (`plan: starter` 等) を検討してください
- 利用は自己責任で。上流サービスの利用規約を尊重し、過度なアクセスで迷惑をかけないでください
