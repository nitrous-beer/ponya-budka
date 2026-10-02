# Поняшина будка

Веб-читалка с Vanilla JS SPA, Node.js API, Nginx и серверным JSON-хранилищем.

## GitHub как источник кода

`deploy.sh` не содержит копии `server.js`, `index.html`, CSS/JS и конфигураций. При запуске он загружает их из GitHub во временный каталог, проверяет и только после этого устанавливает.

В `deploy.sh` перед публикацией укажите:

```bash
GITHUB_OWNER="nitrous-beer"
GITHUB_REPO="ponya-budka"
GITHUB_REF="main"
```

`GITHUB_REF` можно указать как branch, tag или полный commit SHA. Для максимально воспроизводимого production deploy рекомендуется фиксировать commit SHA.

## Установка одной командой

После `git push`:

```bash
curl -sSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash
```

Никакой предварительной установки Git или скачивания архива на сервер вручную не требуется.

## Что загружается из GitHub

- `server.js`
- `index.html`
- `style.css`
- `app.js`
- `budka-api.service`
- `budka.conf`

Файлы сначала попадают в `/tmp/budka-deploy.*`, проходят базовую валидацию, затем устанавливаются.

## Что НЕ загружается из GitHub

Runtime-данные хранятся отдельно:

- `/var/lib/budka/books.json`
- `/var/lib/budka/users.json`

Повторный deploy их не перезаписывает. Поэтому книги и пользователи переживают обновление кода и очистку кэша браузера.

## Обновление

Изменить код → commit → push → снова выполнить:

```bash
curl -sSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash
```

Перед заменой текущего приложения создаётся архив в:

```text
/var/backups/budka/
```

## Сервер

- Nginx: `80` и `9443`
- Node.js API: `127.0.0.1:3000`
- systemd: `budka-api.service`
- frontend: `/var/www/budka`
- data: `/var/lib/budka`
- SSL: `/etc/nginx/ssl/`

HTTP перенаправляется на HTTPS `:9443`.

## Администратор

При первом запуске API создаёт `admin / admin`, если администратора ещё нет. После первого входа bootstrap-пароль необходимо сменить перед публичной эксплуатацией.

## HTTPS

Создаётся самоподписанный сертификат на 365 дней с публичным IP в SAN. Для доступа по IP без доменного имени браузер покажет предупреждение о недоверенном сертификате — это ожидаемое поведение self-signed TLS.

## Структура

```text
ponya-budka/
├── deploy.sh
├── server.js
├── index.html
├── style.css
├── app.js
├── budka-api.service
├── budka.conf
├── .gitignore
└── README.md
```
