#!/usr/bin/env bash
# ============================================================================
# koetomo-relay セットアップスクリプト
# 対象: Oracle Cloud Always Free(東京/大阪)などの「日本にある」Ubuntu 22.04+ VPS
#
# 役割:
#   - Node.js 20 のインストール
#   - relay.js の配置(/opt/koetomo-relay)
#   - 認証トークン + 自己署名証明書(このサーバのグローバルIPをSANに埋め込み)の生成
#   - systemd サービス登録(koetomo-relay)・自動起動
#   - OS ファイアウォール(iptables)でポート開放
#   - 最後に「Render の環境変数に貼る2行」を表示
#
# 使い方(日本サーバ上で):
#   bash setup-oracle.sh            # 既定ポート 8443
#   RELAY_PORT=9443 bash setup-oracle.sh
#
# ※ Oracle Cloud の場合、これとは別に VCN セキュリティリストでのポート開放が必要です
#   (relay/README.md の手順3を参照)
# ============================================================================
set -euo pipefail

PORT="${RELAY_PORT:-8443}"
INSTALL_DIR=/opt/koetomo-relay
ETC_DIR=/etc/koetomo-relay
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== [1/6] グローバルIPの取得 =="
PUBLIC_IP=$(curl -fsS -m 10 https://ipinfo.io/ip 2>/dev/null || curl -fsS -m 10 https://api.ipify.org)
echo "   PUBLIC_IP=$PUBLIC_IP"

echo "== [2/6] Node.js 20 の確認/インストール =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  NARCH=x64 ;;
    aarch64) NARCH=arm64 ;;
    *) echo "非対応CPUアーキテクチャ: $ARCH"; exit 1 ;;
  esac
  curl -fsSL "https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz
  sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
echo "   node $(node -v)"

echo "== [3/6] relay.js の配置 =="
sudo mkdir -p "$INSTALL_DIR" "$ETC_DIR"
sudo cp "$SCRIPT_DIR/relay.js" "$INSTALL_DIR/relay.js"

echo "== [4/6] トークンと自己署名証明書(IP SAN付き)の生成 =="
if [ ! -f "$ETC_DIR/token" ]; then
  sudo bash -c "openssl rand -hex 24 > $ETC_DIR/token"
fi
sudo chmod 600 "$ETC_DIR/token"
if [ ! -f "$ETC_DIR/cert.pem" ]; then
  sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$ETC_DIR/key.pem" -out "$ETC_DIR/cert.pem" \
    -subj "/CN=koetomo-relay" \
    -addext "subjectAltName=IP:${PUBLIC_IP},DNS:koetomo-relay" 2>/dev/null
fi
sudo chmod 600 "$ETC_DIR/key.pem"

echo "== [5/6] systemd サービス登録 =="
sudo tee /etc/systemd/system/koetomo-relay.service >/dev/null <<UNIT
[Unit]
Description=koetomo-relay (Japan egress relay for koetomo-proxy)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/node $INSTALL_DIR/relay.js
Restart=always
RestartSec=3
Environment=RELAY_PORT=$PORT
EnvironmentFile=$ETC_DIR/env
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

sudo bash -c "echo RELAY_TOKEN=\$(cat $ETC_DIR/token) > $ETC_DIR/env"
sudo chmod 600 "$ETC_DIR/env"
sudo systemctl daemon-reload
sudo systemctl enable --now koetomo-relay
sleep 1
sudo systemctl is-active koetomo-relay >/dev/null && echo "   サービス稼働中 (active)" || {
  echo "   !! サービス起動失敗。journalctl -u koetomo-relay -n 50 を確認してください"; exit 1; }

echo "== [6/6] OSファイアウォール(iptables)の開放 =="
if command -v iptables >/dev/null 2>&1; then
  if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 6 -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j ACCEPT
  fi
  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

TOKEN=$(sudo cat "$ETC_DIR/token")
CA_B64=$(sudo base64 -w0 "$ETC_DIR/cert.pem")

cat <<DONE

============================================================
✅ セットアップ完了!
次の2行を Render サービスの環境変数にそのまま貼り付けてください
(Environment → Add Environment Variable → Save Changes で自動再デプロイ)
============================================================

RELAY_URL=https://koetomo-relay:${TOKEN}@${PUBLIC_IP}:${PORT}

RELAY_CA_B64=${CA_B64}

============================================================
※ Oracle Cloud の場合は VCN セキュリティリストでも TCP ${PORT} の開放が必要です
   (relay/README.md 手順3)
※ 動作確認: このサーバ上で  curl -sk https://127.0.0.1:${PORT}/healthz  → ok
   外部から  curl -sk https://${PUBLIC_IP}:${PORT}/healthz  → ok
============================================================
DONE
