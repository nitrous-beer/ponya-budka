<div align="center">

# 📚 Поняшина будка

### Локальная электронная библиотека с атмосферным интерфейсом и настоящим перелистыванием страниц

<img src="assets/budka-banner.svg" alt="Поняшина будка" width="100%"/>

<p>
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5"/>
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3"/>
  <img src="https://img.shields.io/badge/JavaScript-vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111" alt="Vanilla JS"/>
  <img src="https://img.shields.io/badge/Node.js-API-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Nginx-HTTPS-009639?style=for-the-badge&logo=nginx&logoColor=white" alt="Nginx"/>
</p>

<p>
  <b>Без сборщика.</b> Без базы данных. Без внешнего CDN для изображений.<br/>
  Один deploy-скрипт — и библиотека готова работать на чистом Ubuntu/Debian.
</p>

</div>

---

## ✨ Что это

**Поняшина будка** — небольшой self-hosted ридер и библиотека для домашнего сервера.

Интерфейс рассчитан на чтение книг прямо в браузере: на компьютере используются две страницы с эффектом перелистывания, на мобильном — удобный одностраничный режим.

### 🎨 Темы

- ☢️ **STALKER PDA**
- 🐉 **Skyrim**
- 🌸 **Anime / Light Novel**
- 💥 **Comic / Pop-Art**
- 📜 **Classic Sepia**
- 🌙 **Night**

### 📖 Возможности ридера

- двухстраничный режим на desktop;
- одностраничный режим на mobile;
- перелистывание страниц;
- прогресс чтения;
- закладки;
- звуки перелистывания через Web Audio;
- адаптивная вёрстка;
- Font Awesome-иконки;
- никаких обязательных внешних изображений.

### 🎲 Маленькие пасхалки

В интерфейсе есть **Magic 8 Ball** и броски кубиков **2d6 / d20**.

---

## 🖥️ Интерфейс и мобильная версия

Интерфейс построен в стиле современной тёмной панели электронной библиотеки:

- левая панель **«Библиотека»** с поиском, категориями и списком книг;
- центральная область каталога и читалки;
- правая панель тем оформления и аперитива на desktop;
- обложки книг генерируются без внешних изображений;
- компактная верхняя навигация;
- нижняя мобильная навигация для быстрого доступа к каталогу, аперитиву, темам и профилю;
- поиск раскрывается отдельной строкой на телефоне;
- в читалке desktop используется разворот на две страницы, mobile — одна страница;
- элементы управления и кнопки адаптируются под ширину экрана.

На мобильных устройствах боковые панели скрываются, чтобы текст книги и каталог занимали максимум доступной ширины.

---

## 🔐 Пользователи и права

| Роль | Возможности |
|---|---|
| 👤 Гость | Просмотр доступных книг |
| 📖 Reader | Чтение, профиль, смена собственного пароля |
| 👑 Admin | Всё выше + создание, редактирование и удаление книг; управление пользователями |

Первичный аккаунт администратора:

```text
Логин: admin
Пароль: admin
```

> ⚠️ После первой установки обязательно смените пароль через профиль администратора.

Пароли хранятся не в открытом виде: используется `scrypt` с солью.

---

## 🚀 Установка

Проект рассчитан на чистый **Ubuntu/Debian**.

Одна команда с GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash
```

Или классический вариант через Git:

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/nitrous-beer/ponya-budka.git
cd ponya-budka
sudo bash deploy.sh
```

После установки приложение будет доступно по:

```text
https://ВАШ_PUBLIC_IP:9443
```

Для self-signed сертификата браузер покажет предупреждение о сертификате — это ожидаемо.

### Полное удаление

В проект встроен безопасный режим удаления. Он удаляет **только компоненты Поняшиной будки**: приложение, серверные данные, бэкапы, systemd unit, Nginx-конфигурацию, созданный сертификат и созданные этим экземпляром правила UFW.

Системные Node.js, Nginx, curl, OpenSSL, UFW и другие пакеты **не удаляются**. Чужие сайты, конфигурации и сервисы тоже не затрагиваются. Если до установки был включён стандартный Nginx-сайт `default`, скрипт запоминает это и восстанавливает его при удалении.

Из клонированного репозитория:

```bash
sudo bash deploy.sh --uninstall
```

Скрипт попросит ввести `DELETE BUDKA`. Для заранее подтверждённого удаления:

```bash
sudo bash deploy.sh --uninstall --yes
```

Удаление напрямую из GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash -s -- --uninstall
```

Для автоматического удаления без вопроса:

```bash
curl -fsSL https://raw.githubusercontent.com/nitrous-beer/ponya-budka/main/deploy.sh | sudo bash -s -- --uninstall --yes
```

**Важно:** удаление безвозвратно удаляет `/var/lib/budka` и `/var/backups/budka`, включая книги и пользователей.

### Что делает `deploy.sh`

1. устанавливает необходимые пакеты;
2. проверяет Node.js;
3. загружает актуальные файлы проекта;
4. создаёт self-signed SSL-сертификат с IP в SAN;
5. настраивает Nginx;
6. создаёт systemd-сервис API;
7. запускает Node.js API;
8. проверяет Nginx и health endpoint.

---

## 🧩 Архитектура

```text
                         ┌─────────────────────┐
                         │      Браузер        │
                         │  SPA HTML/CSS/JS    │
                         └──────────┬──────────┘
                                    │ HTTPS :9443
                                    ▼
                         ┌─────────────────────┐
                         │        Nginx        │
                         │  static + reverse   │
                         │       proxy         │
                         └───────┬─────┬───────┘
                                 │     │
                         static  │     │ /api/*
                                 ▼     ▼
                         /var/www/   Node.js :3000
                           budka       │
                                       ▼
                              /var/lib/budka/
                              ├─ books.json
                              └─ users.json
```

### Стек

- **Frontend:** HTML5 + CSS3 + Vanilla JavaScript
- **Backend:** Node.js HTTP API
- **Storage:** JSON-файлы
- **Web server:** Nginx
- **Process manager:** systemd
- **TLS:** OpenSSL
- **Icons:** Font Awesome CDN
- **Fonts:** Google Fonts

---

## 📁 Структура проекта

```text
ponya-budka/
├── app.js                 # клиентская логика SPA
├── index.html             # интерфейс
├── style.css              # темы и адаптивная вёрстка
│
├── server.js              # Node.js API
├── budka-api.service      # systemd unit
├── budka.conf             # конфигурация Nginx
├── deploy.sh              # установка одной командой
│
├── assets/
│   └── budka-banner.svg   # оформление GitHub README
│
├── .gitignore
└── README.md
```

---

## 🗃️ Данные

Сервер хранит данные в:

```text
/var/lib/budka/books.json
/var/lib/budka/users.json
```

Файлы создаются API автоматически при первом запуске.

---

## 🛡️ Безопасность

Проект рассчитан прежде всего на небольшой self-hosted сервер.

Уже предусмотрены:

- HTTP → HTTPS redirect;
- `HttpOnly` + `Secure` + `SameSite=Strict` cookie;
- хеширование паролей через `scrypt`;
- ограничение попыток входа;
- проверка прав администратора на сервере;
- серверное хранение книг и пользователей;
- Nginx reverse proxy;
- systemd для запуска API.

> Если библиотека будет открыта непосредственно в интернет, рекомендуется дополнительно использовать firewall, VPN или reverse proxy с полноценным публичным TLS-сертификатом.

---

## 🧪 Проверка перед публикацией

Для Node.js:

```bash
node --check server.js
node --check app.js
```

Для shell-скрипта:

```bash
bash -n deploy.sh
```

---

## 🗺️ Идеи для развития

- [ ] полноценное окно смены пароля вместо `prompt()`;
- [ ] загрузка EPUB/PDF;
- [ ] импорт книг через админ-панель;
- [ ] обложки книг;
- [ ] поиск и фильтры;
- [ ] избранное;
- [ ] синхронизация прогресса между устройствами;
- [ ] резервное копирование JSON;
- [ ] PWA/offline-режим.

---

<div align="center">

### 🐴 Сделано для уютного чтения

**Поняшина будка** · self-hosted · simple · atmospheric

</div>
