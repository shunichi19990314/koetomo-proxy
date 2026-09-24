# 日本出口リレー セットアップガイド

声とも (koetomo.fun) は **日本国外のIPを一律 403 で拒否** する地域制限を運用しており、
Render には日本リージョンが無いため、Render 単体では絶対に開けません(実測: 日本ノードのみ200、他19カ国は全て403)。

そこで、**日本にある無料サーバに小さな中継(リレー)を1つ立て**、Render プロキシの上流接続だけを日本経由にします。

```
あなたのブラウザ
   │  https://koetomo.onrender.com (見た目のURLは Render のまま)
   ▼
Render プロキシ (Singapore 等)          … URL書き換え・Cookie・WS中継を担当(既存のまま)
   │  RELAY_URL (Basic認証 + TLS + CONNECT トンネル)
   ▼
koetomo-relay (日本のサーバ・無料)     … relay/relay.js を動かすだけ(依存ゼロ)
   │  日本IPからの接続 ✅
   ▼
koetomo.fun (声とも)
```

リレーは **中身を見ない単なるトンネル**(CONNECT 転送)なので、TLS は Render⇔声とも でエンドツーエンドのまま保たれます。

---

## 手順1: Oracle Cloud Always Free のアカウント作成

1. https://signup.cloud.oracle.com からアカウント作成(メール・電話番号確認あり)
2. クレジットカードの登録が必要(**本人確認用。Always Free リソースは $0 で、勝手に課金されることはありません**)
3. 「Pay As You Go」へのアップグレードを求められた場合も、Always Free 対象シェイプを選ぶ限り無料枠のままです

## 手順2: 日本リージョンでインスタンス作成

ダッシュボード → **Compute → Instances → Create instance**:

| 項目 | 値 |
|---|---|
| Name | `koetomo-relay` |
| Placement | Home Region が **Japan East (Tokyo)** または **Japan Central (Osaka)** になっていることを確認 |
| Image | **Ubuntu 22.04 / 24.04 (aarch64 または x86)** |
| Shape | **VM.Standard.A1.Flex**(ARM・Always Free: OCPU 1〜4 / RAM 6〜24GB まで無料)<br>または **VM.Standard.E2.1.Micro**(AMD・Always Free) |
| VCN | 既定のままでOK。**パブリックIPの割り当てあり** を確認 |
| SSHキー | 「Generate a key pair」→ **秘密鍵・公開鍵を両方ダウンロード**(秘密鍵は紛失すると入れません) |

> ⚠️ A1 Flex(ARM)は東京リージョンだと **「Out of host capacity」で creation に失敗しがち** です。
> その場合は (a) 数時間〜数日おきに再試行、(b) E2.1.Micro(AMD)を選ぶ、(c) 「Upgrade to Pay As You Go」後に A1 を作成(Always Free 枠内は $0 のまま)のいずれか。

## 手順3: VCN セキュリティリストでポート開放(重要・忘れがち)

Oracle はインスタンス内の iptables とは別に、**クラウド側のファイアウォール(VCN)**でも通信を止めます。

1. 作成したインスタンスのページ → **Primary VNIC → Subnet** リンク
2. サブネットのページの **Security Lists**(既定: `Default Security List for ...`)を開く
3. **Add Ingress Rules**:
   - Stateless: **オフ**(チェックしない)
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: **TCP**
   - Destination Port Range: **8443**(スクリプトの既定値。変えた場合はその値)
4. Add Ingress Rules で保存

## 手順4: サーバに接続してセットアップスクリプトを実行

**方法A: PCからSSH**

```bash
# ダウンロードした秘密鍵を使用。ユーザー名は Ubuntu イメージでは ubuntu
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<インスタンスのパブリックIP>
```

**方法B: ブラウザ完結(Oracle Cloud Shell)— PCに何も入れたくない場合**

1. Oracle Cloud コンソール右上の **クラウド・シェル( >_ アイコン )** を開く(ブラウザ内ターミナル、認証済み)
2. コンソールの「SSHキーのダウンロード」で保存した**秘密鍵をクラウド・シェルにアップロード**(ドラッグ&ドロップ)してから:

```bash
chmod 600 ssh-key-*.key
ssh -i ssh-key-*.key ubuntu@<インスタンスのパブリックIP>
```

**どちらの方法でも、サーバに入ったら:**

```bash
git clone https://github.com/shunichi19990314/koetomo-proxy.git
cd koetomo-proxy/relay
bash setup-oracle.sh
```

スクリプトが Node 20 のインストール、トークン・自己署名証明書(IP SAN付き)の生成、
systemd 常駐化、OSファイアウォール開放まで全自动で行い、最後に:

```
RELAY_URL=https://koetomo-relay:<トークン>@<パブリックIP>:8443
RELAY_CA_B64=<証明書のbase64 1行>
```

の **2行を表示します。これが Render に貼る値** です。

動作確認(サーバ上で):

```bash
curl -sk https://127.0.0.1:8443/healthz      # → ok
# PC 側から(VCN が開いていれば):
curl -sk https://<パブリックIP>:8443/healthz  # → ok
```

## 手順5: Render に環境変数を設定

1. Render ダッシュボード → あなたの `koetomo` サービス → **Environment**
2. **Add Environment Variable** で 2 つ追加:
   - `RELAY_URL` = スクリプトが表示した1行目(トークン込み)
   - `RELAY_CA_B64` = 2行目(長い base64。1行のまま貼り付け)
3. **Save Changes** → 自動で再デプロイ
4. デプロイ完了後、**`https://koetomo.onrender.com/__status`** を開く
   - 経路が「🇯🇵 リレー経由」になり、判定が **✅ 上流に受け入れられています** になれば成功
   - そのまま `/` を開けば声ともが動きます

---

## 仕組みとセキュリティ

- `relay.js` は **依存パッケージゼロ**(Node 標準のみ)の最小フォワードプロキシ
- **Basic認証**(48文字hexトークン)必須。無い/違う場合は 407 で拒否
- **接続先許可リスト**: `koetomo.fun`(と診断用の ipinfo.io 等)以外は 403。オープンプロキシ化しません
- **CONNECT 先ポートは 80/443 のみ**
- Render⇔リレー間は **TLS**(自己署名証明書 + Render 側で CA ピン留め検証)
- リレーは TCP を中継するだけで、声ともの TLS/通信内容は復号しません(エンドツーエンド)
- ログには接続先ホストのみ記録(通信内容は記録しません)

## 運用メモ

| やりたいこと | コマンド(日本サーバ上) |
|---|---|
| 状態確認 | `sudo systemctl status koetomo-relay` |
| ログ | `sudo journalctl -u koetomo-relay -n 100 -f` |
| 再起動 | `sudo systemctl restart koetomo-relay` |
| IPが変わったとき | `sudo rm /etc/koetomo-relay/cert.pem && bash setup-oracle.sh`(証明書再生成 → 新しい RELAY_CA_B64 を Render に再設定) |
| トークン再発行 | `sudo bash -c 'openssl rand -hex 24 > /etc/koetomo-relay/token' && bash setup-oracle.sh`(新しい RELAY_URL を Render に再設定) |

## 他の日本VPSを使う場合(ConoHa / さくら / Vultr東京 / AWS東京 等)

`relay.js` はどこでも動きます。最低限これだけ:

```bash
# Node 20+ が入っているサーバで
RELAY_TOKEN=$(openssl rand -hex 24) \
RELAY_PORT=8443 \
node relay.js &

# トークン表示 → RELAY_URL=https://koetomo-relay:<トークン>@<IP>:8443
```

TLS を有効にするには `/etc/koetomo-relay/cert.pem` と `key.pem` を置くだけ
(setup-oracle.sh がやっているのと同じ)。ドメイン + Let's Encrypt の正式証明書がある場合は
`RELAY_CA_B64` 不要(通常検証が通ります)。常駐化は各環境に合わせて systemd / pm2 等で。

## トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| `curl https://IP:8443/healthz` がタイムアウト | VCN セキュリティリスト(手順3)または iptables が閉じている |
| Render の `/__status` が「上流に到達できません」 | RELAY_URL の打ち間違い(トークン・IP・ポート)。Render のログに `relay CONNECT failed` 等が出ます |
| `self-signed certificate` エラー | RELAY_CA_B64 が古い/改行混入。base64 は **1行** で貼り直す。応急: `RELAY_INSECURE=true`(検証省略・非推奨) |
| ✅になったのにサイトが重い/WSが切れる | 無料VPSの帯域・性能起因。声ともは音声系で通信量が多いので、混雑時間帯は特に影響します |
| リレーのIP自体が403 | そのIPレンジがブロック対象。サーバ再起動でIP変更(Oracle)するか、別プロバイダの日本サーバへ |

## 注意

- 声ともは意図的に日本限定で提供されています。この構成でのアクセスが利用規約に抵触する可能性はあり、**アカウント停止リスクを含む自己責任**での利用になります
- Oracle Always Free の利用規約(不正利用禁止・アイドルリソースの回収など)も一読を。放置アカウントは停止されることがあります
- リレーサーバを他人に共有しないでください(トークンが漏れたら即再発行)
