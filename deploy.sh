#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="budka"
APP_DIR="/var/www/budka"
DATA_DIR="${APP_DIR}/data"
BACKUP_DIR="/var/backups/budka"
SERVICE_NAME="budka-api.service"
NGINX_CONF="/etc/nginx/sites-available/budka.conf"
REPO_URL="https://github.com/nitrous-beer/ponya-budka.git"
MODE="${1:-install}"
CONFIRM="${2:-}"

log(){ printf '\033[1;36m[budka]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[budka] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need_root(){ [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Запустите с правами root: sudo bash deploy.sh"; }

backup_data(){
  if [[ -f "${DATA_DIR}/library.db" ]]; then
    local stamp dest
    stamp="$(date +%Y%m%d-%H%M%S)"
    dest="${BACKUP_DIR}/budka-backup-${stamp}"
    mkdir -p "$dest"
    cp -a "${DATA_DIR}" "$dest/" 2>/dev/null || true
    log "Создана резервная копия базы данных: $dest"
  fi
}

uninstall(){
  need_root
  if [[ "$CONFIRM" != "--yes" ]]; then
    echo "Внимание: будут остановлены служба budka-api и конфиг Nginx."
    echo "База данных в ${DATA_DIR} останется нетронутой."
    echo "Для подтверждения выполните: sudo bash deploy.sh --uninstall --yes"
    exit 0
  fi
  backup_data
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME"
  rm -f "/etc/nginx/sites-enabled/budka.conf"
  systemctl daemon-reload
  systemctl reload nginx 2>/dev/null || true
  log "Служба Будки удалена. Пользовательские данные сохранены в ${DATA_DIR}"
  exit 0
}

if [[ "$MODE" == "--uninstall" ]]; then
  uninstall
fi

need_root

log "[1/6] Установка системных зависимостей и компиляторов C++..."
apt-get update -y
apt-get install -y nginx nodejs npm openssl curl git build-essential python3 make g++

mkdir -p "${APP_DIR}" /etc/nginx/ssl "${BACKUP_DIR}"

log "[2/6] Синхронизация репозитория..."
backup_data

if [ -d ".git" ]; then
  cp -r ./* "${APP_DIR}/"
else
  rm -rf /tmp/ponya-budka-temp
  git clone "${REPO_URL}" /tmp/ponya-budka-temp
  cp -r /tmp/ponya-budka-temp/* "${APP_DIR}/"
  rm -rf /tmp/ponya-budka-temp
fi

mkdir -p "${DATA_DIR}" "${APP_DIR}/public"

log "[3/6] Сборка нативных зависимостей (better-sqlite3, bcryptjs)..."
cd "${APP_DIR}"
npm install --production

# --- Инициализация БД и первого администратора с bcrypt хэшем ---
DB_PATH="${DATA_DIR}/library.db"
ADMIN_USER="admin"
GENERATED_PASS=""

node -e "
const Database = require('better-sqlite3');
const db = new Database('${DB_PATH}');
db.exec(\`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
\`);
const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin');
process.exit(row.count === 0 ? 10 : 0);
" || DB_NEEDS_ADMIN=true

if [ "${DB_NEEDS_ADMIN:-false}" = true ]; then
  log "Генерация уникального пароля администратора..."
  GENERATED_PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 16)
  
  node -e "
  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  const db = new Database('${DB_PATH}');
  const hash = bcrypt.hashSync('${GENERATED_PASS}', 10);
  db.prepare(\`
    INSERT INTO users (id, username, password_hash, role)
    VALUES (?, ?, ?, ?)
  \`).run('user-admin-1', '${ADMIN_USER}', hash, 'admin');
  "
fi

log "[4/6] Выпуск SSL-сертификата..."
SERVER_IP=$(curl -s https://api.ipify.org || hostname -I | awk '{print $1}')
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/budka.key \
  -out /etc/nginx/ssl/budka.crt \
  -subj "/CN=${SERVER_IP}"

log "[5/6] Настройка службы systemd (budka-api)..."
cat << EOF_SERVICE > /etc/systemd/system/budka-api.service
[Unit]
Description=Ponya Budka SQLite API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF_SERVICE

cat << "EOF_NGINX" > /etc/nginx/sites-available/budka.conf
server {
    listen 80;
    server_name _;
    return 301 https://$host:9443$request_uri;
}

server {
    listen 9443 ssl;
    server_name _;
    charset utf-8;

    ssl_certificate /etc/nginx/ssl/budka.crt;
    ssl_certificate_key /etc/nginx/ssl/budka.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    root /var/www/budka/public;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
}
EOF_NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/budka.conf /etc/nginx/sites-enabled/

log "[6/6] Назначение прав и запуск сервисов..."
chown -R www-data:www-data "${APP_DIR}"
chmod -R 755 "${APP_DIR}"
chmod -R 770 "${DATA_DIR}"

systemctl daemon-reload
systemctl enable budka-api
systemctl restart budka-api

nginx -t
systemctl restart nginx

which ufw >/dev/null 2>&1 && ufw allow 9443/tcp || true

echo "=========================================================="
echo " РАЗВЕРТЫВАНИЕ УСПЕШНО ЗАВЕРШЕНО!"
echo " Адрес панели: https://${SERVER_IP}:9443"
if [ -n "${GENERATED_PASS}" ]; then
echo "----------------------------------------------------------"
echo " УЧЕТНЫЕ ДАННЫЕ АДМИНИСТРАТОРА (СОХРАНИТЕ):"
echo " Логин:  ${ADMIN_USER}"
echo " Пароль: ${GENERATED_PASS}"
echo " (Пароль захэширован в базе library.db)"
fi
echo "=========================================================="
