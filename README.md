# koetomo-proxy — 本家「声とも」を Render 経由で開くフルリバースプロキシ

[声とも (koetomo.fun)](https://koetomo.fun) への全リクエストを肩代わりするリバースプロキシです。
Render の無料 Web サービスとしてデプロイし、ブラウザでは `https://koetomo-proxy.onrender.com` を開くだけで本家の声ともが動きます。

## 機能

| 機能 | 内容 |
|---|---|
| フルリバースプロキシ | GET / POST / WebSocket を koetomo.fun に転送。HTML・JS・CSS・JSON 内の絶対URL・`wss://`・URLエンコード形式・CSP ヘッダまで自分のオリジンに自動書き換え |
| Cookie / リダイレクト対応 | `Set-Cookie` の `Domain` 剥がし、`Location` 書き換え → ログイン状態がプロキシ側ドメインで維持される設計 |
| **🇯🇵 日本出口リレーモード** | 声ともは**日本国外IPを一律403で拒否**する地域制限あり。Render には日本リージョンが無いため、`RELAY_URL` に日本の無料サーバ(Oracle Cloud Always Free 等)を立てて上流接続だけ日本経由にする構成に対応 → **[relay/README.md](relay/README.md)** |
| `/__status` 診断 | 「上流に受け入れられるIPで繋げているか」を判定(上流ステータス + Render発信IP + リレー出口IP・国・ASN + 日本語の判定文)。リレー経路も自動反映 |
| ブロック説明ページ | 上流 403 時は謎のエラーではなく、原因(地域ブロック)と対処(リレー構築手順への誘導)を書いた日本語ページを返す。アプリ本来の 403 JSON は素通し |
| `render.yaml` | Blueprint で **New + → Blueprint → リポジトリ選択** だけで `https://koetomo-proxy.onrender.com` が完成(Web Service からの手動作成でも同じ) |
| 自動テスト | 直接モード33項目 + リレーチェーンモード22項目(地域ゲート模擬上流を使って「直接403→リレー経由200」まで検証) |

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

## 開けない(403)ときは → 日本出口リレー

声ともは **日本国外のIPを一律 403** にする地域制限を運用しています(実測: 日本ノードのみ 200、他19カ国は全て 403)。
**Render には日本リージョンが無い**ため、Manual Deploy でIPを何回転がしても、リージョンを変えても、Render 単体では絶対に通りません。

解決策は「日本に小さな中継(リレー)を1つ立てる」だけです。見た目のURLは Render のまま、上流への接続だけが日本出口になります。

```
ブラウザ → Render プロキシ(既存・変更不要) → koetomo-relay(日本の無料VPS) → koetomo.fun
```

- 手順: **[relay/README.md](relay/README.md)**(Oracle Cloud Always Free 東京/大阪で $0、`bash relay/setup-oracle.sh` 一発)
- Render 側に足す環境変数は 2 つだけ: `RELAY_URL` と `RELAY_CA_B64`(スクリプトが最後に出力します)
- リレーは Basic認証 + 接続先許可リスト(koetomo.fun 等)+ CONNECT先 80/443 限定で、オープンプロキシ化しません。声ともの TLS はエンドツーエンドのまま中継されます

## /__status の読み方

| 項目 | 意味 |
|---|---|
| HTTP ステータス / Server | 声とも側のエッジサーバが Render の IP をどう扱ったか(例: `403` + `awselb/2.0` = AWS ロードバランサ段階で拒否) |
| 発信IP・国・ASN | この Render インスタンスが「外から見える IP」。データセンタ IP かどうかの判断材料 |
| 判定文 | ✅ 受け入れ / ❌ IP ブロック / ⚠️ 到達不能・上流エラー、を日本語で表示 |

JSON が欲しければ `/__status?format=json`。

## 403 が出たとき

実測の結果、声ともの 403 は **日本国外IPに対する地域ブロック** です(日本のデータセンタIPは通り、他19カ国はサーバIPでも全滅)。そのため:

- ❌ **Manual Deploy(IPガチャ)・リージョン変更は無意味** — Render に日本リージョンが無い以上、直接接続は通りません
- ✅ **正解は「日本出口リレー」** — 上の [日本出口リレー](#開けない403ときは--日本出口リレー) の手順(relay/README.md)で、日本の無料サーバに `relay/relay.js` を立てて `RELAY_URL` を設定してください
- リレー設定後も 403 が出る場合は `/__status` の「リレーの出口IP」が日本 (JP) になっているか確認(なっていなければ RELAY_URL の指定ミス、なっていて 403 ならそのリレーのIPレンジがブロック対象 → リレー再起動でIP変更 or 別プロバイダ)
- 一時的な障害・メンテナンスの可能性もあるので、時間帯を変えた再確認も有効

## ローカル開発・テスト

```bash
npm install
npm start              # http://localhost:10000 → https://koetomo.fun へのプロキシとして起動

# 自動テスト
npm test
#   ├ test/smoke.js        直接モード 33項目(URL書き換え/Cookie/WS/SSE/403/診断/オープンプロキシ防止)
#   └ test/chain-smoke.js  リレーチェーン 22項目(「日本国外IPは403」を模擬するgeo上流 + リレー + プロキシの3段構成で
#                          直接403→リレー経由200・書き換え・WS中継・リレー認証/許可リスト・/__status判定まで検証)
```

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート(Render が自動設定) |
| `UPSTREAM` | `https://koetomo.fun` | プロキシ先 |
| `PUBLIC_ORIGIN` | (リクエストの Host から自動判定) | URL 書き換えに使う自分のオリジンを固定したい場合のみ設定 |
| `TZ` | `Asia/Tokyo` | 診断ページの時刻表示用 |
| `RELAY_URL` | (未設定=直接接続) | **日本出口リレー**のURL。`https://koetomo-relay:<トークン>@<日本のIP>:8443` 形式。設定すると上流接続とWebSocketがこのリレー経由になり、地域ブロックを回避できます |
| `RELAY_CA_B64` | (なし) | リレーの自己署名証明書(base64・1行)。`relay/setup-oracle.sh` が出力します |
| `RELAY_INSECURE` | (なし) | `true` でリレー証明書の検証を省略(非推奨。CAピン留めが使えない場合の応急用) |

## 仕組みメモ

- HTTP 転送は `undici` パッケージの `fetch`(リレー経由の `dispatcher` 指定が必要なため組み込み fetch ではなくパッケージ版を使用)。上流の gzip/br は自動解凍してから書き換え・再送するため `Content-Encoding`/`Content-Length` は正しく再計算されます
- 書き換え対応フォーマット: `https://` `http://` `wss://` `ws://` / `\/\/` エスケープ形式 / `%3A%2F%2F`・`%253A%252F%252F` エンコード形式 / プロトコル相対 `//host`(すべて `www.` 付きも含む、大小文字無視)
- `Origin`・`Referer` は上流ネイティブの値に補正してから転送(CSRF/Origin チェック対策)
- 3xx は `manual` で受け、`Location` が声とも向きなら自オリジンへ書き換え、外部(OAuth 等)なら素通し
- WebSocket は `upgrade` を捕捉し `ws` で上流へブリッジ。上流接続確立前のクライアント送信は**リスナ登録前のメッセージも取りこぼさないよう、ハンドシェイク完了直後からキュー**して開通後にまとめて転送
- **リレーモード**: HTTP は undici `ProxyAgent`(CONNECT トンネル)、WS は自前の CONNECT トンネル確立 → `wss://` の場合は TLS ラップ → `ws` の `createConnection` に注入。声ともの TLS はエンドツーエンドで保たれ、リレーは中身を復号しません
- SSE (`text/event-stream`) はチャンク単位で書き換えながらストリーム
- バイナリ(画像/音声/フォント等)は無加工・ストリーム素通し。テキストは 25MB までバッファ書き換え
- absolute-form (`GET http://example.com/`) は 400 で拒否 → オープンプロキシ化を防止
- リレー (`relay/relay.js`) も同様に absolute-form/CONNECT とも **Basic認証 + ホスト許可リスト + ポート 80/443 限定**

## 制限・注意

- 対象は `koetomo.fun` / `www.koetomo.fun` のみ。他サブドメイン(`cdn.` など)が使われている場合は書き換え対象外です(現状 DNS 上 www は解決しません)
- 声ともの地域制限(日本限定)はリレー構成で回避できますが、**リレーの日本IP自体が弾かれた場合**はリレーのIP変更/プロバイダ変更が必要です(`/__status` で切り分け可能)
- Render 無料プラン: スリープあり(15分無アクセス→復帰に数十秒)・月 512MB アウトバウンド等の制約あり。音声系アプリは通信量が多くなりがちなので、ヘビーユースは有料プラン (`plan: starter` 等) を検討してください
- 声ともは意図的に日本限定で提供されています。リレー/VPN等でのアクセスは利用規約に抵触し得るため、**アカウント停止リスクを含む自己責任**で判断してください。上流に過度なアクセス負荷をかけないこと
