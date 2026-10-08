#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/var/www/budka"
DATA_DIR="/var/lib/budka"
BACKUP_DIR="/var/backups/budka"
SERVICE_FILE="/etc/systemd/system/budka-api.service"
NGINX_FILE="/etc/nginx/sites-available/budka.conf"
SSL_DIR="/etc/nginx/ssl"
STATE_FILE="$DATA_DIR/install-state"
OWNER="${GITHUB_OWNER:-nitrous-beer}"
REPO="${GITHUB_REPO:-ponya-budka}"
REF="${GITHUB_REF:-main}"
RAW_BASE="${GITHUB_RAW_BASE:-https://raw.githubusercontent.com/$OWNER/$REPO/$REF}"
UNINSTALL=0
YES=0

usage(){ cat <<'HELP'
Поняшина будка

Установка:
  sudo bash deploy.sh

Удаление только Будки:
  sudo bash deploy.sh --uninstall
  sudo bash deploy.sh --uninstall --yes

Можно выбрать ветку:
  sudo GITHUB_REF=main bash deploy.sh
HELP
}
for arg in "$@"; do case "$arg" in --uninstall) UNINSTALL=1;; --yes) YES=1;; -h|--help) usage; exit 0;; *) echo "Неизвестный аргумент: $arg" >&2; exit 2;; esac; done
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo bash deploy.sh" >&2; exit 1; }

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$YES" -ne 1 ]; then
    echo "Будут удалены только компоненты Поняшиной будки:"; printf '%s\n' "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR" "$SERVICE_FILE" "$NGINX_FILE" "$SSL_DIR/budka.crt" "$SSL_DIR/budka.key"
    echo "Системные пакеты и сторонние сайты удаляться НЕ будут."
    read -r -p 'Введите DELETE BUDKA для подтверждения: ' confirm
    [ "$confirm" = "DELETE BUDKA" ] || { echo 'Отмена.'; exit 0; }
  fi
  UFW80=0; UFW9443=0; DEFAULT_ENABLED=0; DEFAULT_TARGET=''
  [ -f "$STATE_FILE" ] && source "$STATE_FILE" || true
  systemctl disable --now budka-api.service 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  rm -f /etc/nginx/sites-enabled/budka.conf "$NGINX_FILE"
  if [ "${DEFAULT_ENABLED:-0}" = "1" ]; then
    if [ -n "${DEFAULT_TARGET:-}" ] && [ -e "$DEFAULT_TARGET" ]; then ln -sfn "$DEFAULT_TARGET" /etc/nginx/sites-enabled/default; elif [ -e /etc/nginx/sites-available/default ]; then ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default; fi
  fi
  rm -f "$SSL_DIR/budka.crt" "$SSL_DIR/budka.key"; rmdir "$SSL_DIR" 2>/dev/null || true
  systemctl daemon-reload
  if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then systemctl reload nginx || true; fi
  rm -rf "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
  command -v ufw >/dev/null 2>&1 && { [ "${UFW80:-0}" = "1" ] && ufw delete allow 80/tcp >/dev/null 2>&1 || true; [ "${UFW9443:-0}" = "1" ] && ufw delete allow 9443/tcp >/dev/null 2>&1 || true; } || true
  echo 'ПОНЯШИНА БУДКА удалена. Системные пакеты и чужие сервисы сохранены.'
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl openssl nginx ufw

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 20 ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs; fi

PUBLIC_IP="$(curl -4fsS --connect-timeout 5 --max-time 10 https://api.ipify.org || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"
[ -n "$PUBLIC_IP" ] || { echo 'Не удалось определить IP для сертификата.' >&2; exit 1; }

install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR" "$SSL_DIR"
TMP_DIR="$(mktemp -d /tmp/budka-deploy.XXXXXX)"; trap 'rm -rf "$TMP_DIR"' EXIT
fetch(){ curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 "$RAW_BASE/$1" -o "$TMP_DIR/$1"; test -s "$TMP_DIR/$1"; }
for f in index.html style.css app.js server.js manifest.json sw.js budka-api.service budka.conf assets/budka-logo.svg; do mkdir -p "$TMP_DIR/$(dirname "$f")"; echo "GitHub: $f"; fetch "$f"; done

node --check "$TMP_DIR/server.js"
node --check "$TMP_DIR/app.js"
grep -q '^server {' "$TMP_DIR/budka.conf"
grep -q 'ExecStart=/usr/bin/node /var/www/budka/server.js' "$TMP_DIR/budka-api.service"

if [ -f "$APP_DIR/server.js" ]; then tar -czf "$BACKUP_DIR/budka-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$APP_DIR" . 2>/dev/null || true; fi
install -d -m 0755 "$APP_DIR/assets"
install -m 0644 "$TMP_DIR/index.html" "$APP_DIR/index.html"
install -m 0644 "$TMP_DIR/style.css" "$APP_DIR/style.css"
install -m 0644 "$TMP_DIR/app.js" "$APP_DIR/app.js"
install -m 0644 "$TMP_DIR/server.js" "$APP_DIR/server.js"
install -m 0644 "$TMP_DIR/manifest.json" "$APP_DIR/manifest.json"
install -m 0644 "$TMP_DIR/sw.js" "$APP_DIR/sw.js"
install -m 0644 "$TMP_DIR/assets/budka-logo.svg" "$APP_DIR/assets/budka-logo.svg"
install -m 0644 "$TMP_DIR/budka-api.service" "$SERVICE_FILE"
install -m 0644 "$TMP_DIR/budka.conf" "$NGINX_FILE"

# Runtime JSON is deliberately created outside GitHub. Empty valid JSON lets server.js seed demo data safely.
[ -s "$DATA_DIR/books.json" ] || printf '[]\n' > "$DATA_DIR/books.json"
[ -s "$DATA_DIR/users.json" ] || printf '[]\n' > "$DATA_DIR/users.json"
chown -R www-data:www-data "$APP_DIR" "$DATA_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
chmod 0750 "$DATA_DIR"; chmod 0640 "$DATA_DIR/books.json" "$DATA_DIR/users.json"

if [ ! -s "$SSL_DIR/budka.crt" ] || [ ! -s "$SSL_DIR/budka.key" ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -keyout "$SSL_DIR/budka.key" -out "$SSL_DIR/budka.crt" -subj "/CN=$PUBLIC_IP" -addext "subjectAltName=IP:$PUBLIC_IP"
fi
chmod 0600 "$SSL_DIR/budka.key"; chmod 0644 "$SSL_DIR/budka.crt"

DEFAULT_ENABLED=0; DEFAULT_TARGET=''
if [ -e /etc/nginx/sites-enabled/default ] || [ -L /etc/nginx/sites-enabled/default ]; then DEFAULT_ENABLED=1; [ -L /etc/nginx/sites-enabled/default ] && DEFAULT_TARGET="$(readlink /etc/nginx/sites-enabled/default || true)"; fi
ln -sfn "$NGINX_FILE" /etc/nginx/sites-enabled/budka.conf
rm -f /etc/nginx/sites-enabled/default
UFW80=0; UFW9443=0
if command -v ufw >/dev/null 2>&1; then if ! ufw status 2>/dev/null | grep -q '^80/tcp.*ALLOW'; then ufw allow 80/tcp >/dev/null || true; UFW80=1; fi; if ! ufw status 2>/dev/null | grep -q '^9443/tcp.*ALLOW'; then ufw allow 9443/tcp >/dev/null || true; UFW9443=1; fi; fi
cat > "$STATE_FILE" <<STATE
UFW80=$UFW80
UFW9443=$UFW9443
DEFAULT_ENABLED=$DEFAULT_ENABLED
DEFAULT_TARGET=$(printf '%q' "$DEFAULT_TARGET")
STATE
chown www-data:www-data "$STATE_FILE"; chmod 0640 "$STATE_FILE"

nginx -t
systemctl daemon-reload
systemctl enable --now budka-api.service
systemctl enable nginx
systemctl restart nginx

ok=0
for _ in $(seq 1 12); do if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then ok=1; break; fi; sleep 1; done
[ "$ok" -eq 1 ] || { journalctl -u budka-api.service -n 60 --no-pager >&2; exit 1; }
curl -kfsS --resolve "$PUBLIC_IP:9443:127.0.0.1" "https://$PUBLIC_IP:9443/api/health" >/dev/null

echo
cat <<SUMMARY
============================================================
 ПОНЯШИНА БУДКА — ГОТОВО
============================================================
 URL:      https://$PUBLIC_IP:9443/
 API:      http://127.0.0.1:3000/api/health
 APP:      $APP_DIR
 DATA:     $DATA_DIR
 BACKUPS:  $BACKUP_DIR
 SOURCE:   $RAW_BASE

 Первичный вход: admin / admin
 Сразу после входа смените пароль.

 Повторная установка без потери данных:
   sudo bash deploy.sh
 Полностью с нуля:
   sudo bash deploy.sh --uninstall --yes
   sudo bash deploy.sh
============================================================
SUMMARY
