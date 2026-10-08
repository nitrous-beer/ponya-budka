# 📚 Поняшина будка

Self-hosted библиотека и электронная читалка в стиле цифровой рабочей станции: каталог слева, книжный разворот по центру и инструменты справа.

## Что изменено в этой версии

- новый desktop-интерфейс по референсу пользователя;
- отдельная мобильная компоновка с нижней навигацией;
- книжный разворот на ПК и одна страница на телефоне;
- темы S.T.A.L.K.E.R., Skyrim, Anime, Comic, Classic, Night;
- рабочий «Аперитив»: Magic 8 Ball, 2d6 и d20 1–20;
- безопасная смена пароля;
- строгие роли `admin` / `reader`;
- нормализация старых ролей при старте;
- корректная первичная инициализация JSON;
- PWA manifest + service worker;
- Node.js API + Nginx + systemd;
- установка и повторная установка одной командой на Ubuntu/Debian;
- данные находятся вне репозитория: `/var/lib/budka`.

## Быстрая установка

```bash
curl -fsSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash
```

Откройте:

```text
https://SERVER_IP:9443/
```

Первичный пользователь: `admin` / `admin`. Сразу смените пароль.

## Полное удаление только Будки

```bash
sudo bash deploy.sh --uninstall
```

Скрипт не удаляет системные Node.js/Nginx/OpenSSL/UFW и сторонние сервисы.

## Проверка

```bash
bash -n deploy.sh
node --check server.js
node --check app.js
```

После запуска:

```bash
curl http://127.0.0.1:3000/api/health
systemctl status budka-api.service --no-pager
nginx -t
```

## Архитектура

```text
Browser
  │ HTTPS :9443
  ▼
Nginx ───── static HTML/CSS/JS/PWA
  │ /api/*
  ▼
Node.js :3000
  │
  ▼
/var/lib/budka/books.json
/var/lib/budka/users.json
```

## Структура

```text
ponya-budka/
├── assets/budka-logo.svg
├── .github/ISSUE_TEMPLATE/
├── index.html
├── style.css
├── app.js
├── server.js
├── manifest.json
├── sw.js
├── budka-api.service
├── budka.conf
├── deploy.sh
├── .gitignore
└── README.md
```

## Лицензия

Внутренний self-hosted проект. Вы можете адаптировать интерфейс и содержимое под свою библиотеку.
