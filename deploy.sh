#!/usr/bin/env bash
set -e

APP_DIR="/var/www/budka"
DATA_DIR="/var/lib/budka"
SERVICE_FILE="/etc/systemd/system/budka-api.service"
NGINX_FILE="/etc/nginx/sites-available/budka.conf"
SSL_DIR="/etc/nginx/ssl"
BACKUP_DIR="/var/backups/budka"
STATE_FILE="$DATA_DIR/install-state"
NGINX_DEFAULT_WAS_ENABLED=0
NGINX_DEFAULT_TARGET=""

UNINSTALL=0
UNINSTALL_YES=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --yes) UNINSTALL_YES=1 ;;
    -h|--help)
      cat <<'EOF_HELP'
Поняшина будка

Установка:
  sudo bash deploy.sh

Полное удаление только компонентов Поняшиной будки:
  sudo bash deploy.sh --uninstall
  sudo bash deploy.sh --uninstall --yes

Удаление НЕ деинсталлирует системные Node.js, Nginx, curl, OpenSSL, UFW
или другие пакеты, которые могли быть установлены до Поняшиной будки.
EOF_HELP
      exit 0
      ;;
    *)
      echo "ERROR: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done


if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: запустите скрипт от root, например: curl -sSL <raw-url> | sudo bash" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Uninstall mode: remove ONLY files/services created for Поняшина будка.
# Never apt-remove shared/system packages here.
# -----------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$UNINSTALL_YES" -ne 1 ]; then
    echo "Будут удалены данные и компоненты Поняшиной будки:"
    echo "  - $APP_DIR"
    echo "  - $DATA_DIR"
    echo "  - $BACKUP_DIR"
    echo "  - $SERVICE_FILE"
    echo "  - $NGINX_FILE и ссылка sites-enabled/budka.conf"
    echo "  - $SSL_DIR/budka.crt и $SSL_DIR/budka.key"
    echo
    echo "Системные Node.js/Nginx/curl/OpenSSL/UFW и чужие сайты удаляться НЕ будут."
    printf 'Для подтверждения введите DELETE BUDKA: '
    read -r confirmation
    if [ "$confirmation" != "DELETE BUDKA" ]; then
      echo "Отмена."
      exit 0
    fi
  fi

  UFW_ADDED_80=0
  UFW_ADDED_9443=0
  NGINX_DEFAULT_WAS_ENABLED=0
  NGINX_DEFAULT_TARGET=""
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi

  echo "==> Остановка и удаление API"
  systemctl disable --now budka-api.service 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload

  echo "==> Удаление конфигурации Nginx Будки"
  rm -f /etc/nginx/sites-enabled/budka.conf "$NGINX_FILE"
  if [ "$NGINX_DEFAULT_WAS_ENABLED" = "1" ] && [ -n "$NGINX_DEFAULT_TARGET" ]; then
    ln -sfn "$NGINX_DEFAULT_TARGET" /etc/nginx/sites-enabled/default
  elif [ "$NGINX_DEFAULT_WAS_ENABLED" = "1" ] && [ -f /etc/nginx/sites-available/default ]; then
    ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  fi
  rm -f "$SSL_DIR/budka.crt" "$SSL_DIR/budka.key"
  rmdir "$SSL_DIR" 2>/dev/null || true

  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
    else
      echo "WARNING: Nginx config after удаления Будки не прошла проверку; Nginx не перезапущен." >&2
    fi
  fi

  echo "==> Удаление данных, приложения и бэкапов Будки"
  rm -rf "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"

  # Remove firewall rules only when this installation recorded that it created them.
  # Existing rules are deliberately preserved.
  if command -v ufw >/dev/null 2>&1; then
    if [ "$UFW_ADDED_80" = "1" ]; then ufw delete allow 80/tcp >/dev/null 2>&1 || true; fi
    if [ "$UFW_ADDED_9443" = "1" ]; then ufw delete allow 9443/tcp >/dev/null 2>&1 || true; fi
  fi

  echo
  echo "============================================================"
  echo "  ПОНЯШИНА БУДКА — УДАЛЕНИЕ ЗАВЕРШЕНО"
  echo "============================================================"
  echo "Удалены только компоненты проекта, его данные и конфигурация."
  echo "Системные пакеты и сторонние сайты/сервисы НЕ удалялись."
  echo "============================================================"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl openssl nginx ufw

# Node.js 24.x LTS: используем системный Node, если он уже достаточно новый; иначе NodeSource.
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

PUBLIC_IP="$(curl -s https://api.ipify.org || true)"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(hostname -I | awk '{print $1}')"
fi
if [ -z "$PUBLIC_IP" ]; then
  echo "ERROR: не удалось определить публичный IP." >&2
  exit 1
fi

echo "==> Public IP: $PUBLIC_IP"

install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$SSL_DIR"

# -----------------------------------------------------------------------------
# GitHub source of truth
# -----------------------------------------------------------------------------
# Set these once in the repository's deploy.sh. They can also be overridden at
# runtime, e.g. `sudo GITHUB_RAW_BASE=... bash`.
GITHUB_OWNER="${GITHUB_OWNER:-nitrous-beer}"
GITHUB_REPO="${GITHUB_REPO:-ponya-budka}"
GITHUB_REF="${GITHUB_REF:-main}"
GITHUB_RAW_BASE="${GITHUB_RAW_BASE:-https://raw.githubusercontent.com/$GITHUB_OWNER/$GITHUB_REPO/$GITHUB_REF}"
GITHUB_CONNECT_TIMEOUT="${GITHUB_CONNECT_TIMEOUT:-10}"
GITHUB_MAX_TIME="${GITHUB_MAX_TIME:-60}"

case "$GITHUB_RAW_BASE" in
  https://raw.githubusercontent.com/*) ;;
  *)
    echo "ERROR: GITHUB_RAW_BASE должен начинаться с https://raw.githubusercontent.com/" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d /tmp/budka-deploy.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fetch_file() {
  local name="$1"
  local destination="$TMP_DIR/$name"
  echo "==> GitHub: $name"
  curl -fsSL --retry 3 --retry-delay 1 \
    --connect-timeout "$GITHUB_CONNECT_TIMEOUT" \
    --max-time "$GITHUB_MAX_TIME" \
    -H 'Accept: application/octet-stream' \
    "$GITHUB_RAW_BASE/$name" -o "$destination"
  test -s "$destination"
}

# Keep runtime data outside GitHub. Only application/configuration files are fetched.
for file in server.js index.html style.css app.js budka-api.service budka.conf; do
  fetch_file "$file"
done

# Validate downloaded source before touching the running installation.
echo "==> Проверка загруженных файлов"
/usr/bin/node --check "$TMP_DIR/server.js"
/usr/bin/node --check "$TMP_DIR/app.js"
grep -q '<!doctype html' "$TMP_DIR/index.html"
grep -q 'server {' "$TMP_DIR/budka.conf"

# Validate that the service points to the deployed application path.
grep -q 'ExecStart=/usr/bin/node /var/www/budka/server.js' "$TMP_DIR/budka-api.service"

# -----------------------------------------------------------------------------
# Backup current application/configuration before replacing it.
# -----------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
chmod 0750 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/budka-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
if [ -f "$APP_DIR/server.js" ]; then
  echo "==> Бэкап текущей версии: $BACKUP_FILE"
  tar -czf "$BACKUP_FILE" -C "$APP_DIR" server.js index.html style.css app.js 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# Install application files downloaded from GitHub.
# -----------------------------------------------------------------------------
echo "==> Установка файлов приложения"
install -d -m 0755 "$APP_DIR"
install -m 0644 "$TMP_DIR/index.html" "$APP_DIR/index.html"
install -m 0644 "$TMP_DIR/style.css" "$APP_DIR/style.css"
install -m 0644 "$TMP_DIR/app.js" "$APP_DIR/app.js"
install -m 0644 "$TMP_DIR/server.js" "$APP_DIR/server.js"

# Keep service and Nginx config under version control as well.
install -m 0644 "$TMP_DIR/budka-api.service" "$SERVICE_FILE"
install -m 0644 "$TMP_DIR/budka.conf" "$NGINX_FILE"

# -----------------------------------------------------------------------------
# Persistent server-side storage. NEVER fetch these files from GitHub.
# -----------------------------------------------------------------------------
# The API initializes books.json/users.json on first start.
# Do not create empty files here, otherwise the demo book would be skipped.

# Self-signed certificate with the real public IP in SAN, valid for 365 days.
if [ ! -s "$SSL_DIR/budka.crt" ] || [ ! -s "$SSL_DIR/budka.key" ]; then
  echo "==> Генерация self-signed SSL для $PUBLIC_IP"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
    -keyout "$SSL_DIR/budka.key" \
    -out "$SSL_DIR/budka.crt" \
    -subj "/CN=$PUBLIC_IP" \
    -addext "subjectAltName=IP:$PUBLIC_IP"
fi
chmod 0600 "$SSL_DIR/budka.key"
chmod 0644 "$SSL_DIR/budka.crt"

# Persistent data must be writable by the API, static files readable by Nginx.
chown -R www-data:www-data "$APP_DIR" "$DATA_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
chmod 0750 "$DATA_DIR"
for data_file in "$DATA_DIR/books.json" "$DATA_DIR/users.json"; do
  if [ -f "$data_file" ]; then
    chmod 0640 "$data_file"
  fi
done

# Enable this site and disable the distro default to avoid conflicting server blocks.
# Remember whether the default site was enabled so uninstall can restore it.
if [ -L /etc/nginx/sites-enabled/default ] || [ -e /etc/nginx/sites-enabled/default ]; then
  NGINX_DEFAULT_WAS_ENABLED=1
  if [ -L /etc/nginx/sites-enabled/default ]; then
    NGINX_DEFAULT_TARGET="$(readlink /etc/nginx/sites-enabled/default || true)"
  fi
fi
ln -sfn "$NGINX_FILE" /etc/nginx/sites-enabled/budka.conf
rm -f /etc/nginx/sites-enabled/default

# UFW: add rules if UFW exists, but do not force-enable it and risk SSH lockout.
# Preserve ownership information across redeploys.
UFW_ADDED_80=0
UFW_ADDED_9443=0
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi
if command -v ufw >/dev/null 2>&1; then
  if ! ufw status 2>/dev/null | grep -Eq '^80/tcp[[:space:]]+ALLOW'; then
    ufw allow 80/tcp >/dev/null || true
    UFW_ADDED_80=1
  fi
  if ! ufw status 2>/dev/null | grep -Eq '^9443/tcp[[:space:]]+ALLOW'; then
    ufw allow 9443/tcp >/dev/null || true
    UFW_ADDED_9443=1
  fi
fi

cat > "$STATE_FILE" <<EOF_STATE
# Budka installer state. Used only to safely undo changes created by this install.
UFW_ADDED_80=$UFW_ADDED_80
UFW_ADDED_9443=$UFW_ADDED_9443
NGINX_DEFAULT_WAS_ENABLED=$NGINX_DEFAULT_WAS_ENABLED
NGINX_DEFAULT_TARGET=${NGINX_DEFAULT_TARGET@Q}
EOF_STATE
chmod 0640 "$STATE_FILE"
chown www-data:www-data "$STATE_FILE"

# Validate Nginx configuration before restarting services.
echo "==> Проверка Nginx"
nginx -t

systemctl daemon-reload
systemctl enable budka-api.service
systemctl restart budka-api.service
systemctl enable nginx
systemctl restart nginx

# Basic post-deploy health check through the local API.
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [ "$HEALTH_OK" -ne 1 ]; then
  echo "ERROR: budka-api не прошел health-check. Последние логи:" >&2
  journalctl -u budka-api.service -n 50 --no-pager >&2 || true
  exit 1
fi

# Verify the public Nginx endpoint locally using the certificate despite its self-signed status.
if ! curl -kfsS --resolve "$PUBLIC_IP:9443:127.0.0.1" \
    "https://$PUBLIC_IP:9443/api/health" >/dev/null; then
  echo "ERROR: Nginx HTTPS health-check не прошел." >&2
  nginx -t >&2 || true
  systemctl status nginx --no-pager >&2 || true
  exit 1
fi

cat <<EOF_SUMMARY

============================================================
  ПОНЯШИНА БУДКА — DEPLOY ИЗ GITHUB ЗАВЕРШЕН
============================================================
  Source:    $GITHUB_RAW_BASE
  URL:       https://$PUBLIC_IP:9443/
  HTTP:      http://$PUBLIC_IP/  -> HTTPS :9443
  API:       http://127.0.0.1:3000/api/health
  API unit:  budka-api.service
  App:       $APP_DIR
  Books:     $DATA_DIR/books.json
  Users:     $DATA_DIR/users.json
  Backup:    $BACKUP_DIR
  SSL:       $SSL_DIR/budka.crt (365 дней)

  Первичный администратор:
    login:    admin
    password: admin

  Runtime-данные НЕ загружаются из GitHub и сохраняются между deploy.
  Самоподписанный сертификат браузер покажет как недоверенный — это
  ожидаемо для прямого доступа по IP без доменного имени.
============================================================
EOF_SUMMARY
