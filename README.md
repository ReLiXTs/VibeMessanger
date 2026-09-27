# VibeMessenger

Self-hosted мессенджер в реальном времени на Node.js + Express + Socket.IO.
Ставится одной командой на VPS: спросит домен, сам выпустит SSL-сертификат и поднимет всё в Docker.

## Установка на VPS (одна команда)

На чистом сервере (Ubuntu/Debian, нужен root):

```bash
curl -fsSL https://github.com/ReLiXTs/VibeMessanger/releases/latest/download/get.sh | bash
```

Что произойдёт:
1. Установится Docker (если его нет) и плагин `docker compose`.
2. Установщик спросит **домен** (например `chat.example.com`) и **email** для Let's Encrypt.
3. Сгенерируется `.env` со случайным секретом.
4. Проверится DNS (A-запись домена должна указывать на IP сервера).
5. Соберётся и запустится стек: приложение + Caddy.
6. Caddy **автоматически выпустит SSL-сертификат** Let's Encrypt и будет обновлять его.

После установки мессенджер доступен по `https://ваш-домен`.

> Убедитесь, что A-запись домена указывает на IP сервера **до** установки, иначе сертификат не выпустится.

### Управление

```bash
cd /opt/vibemessenger
docker compose logs -f      # логи
docker compose restart      # перезапуск
docker compose down         # остановить
docker compose up -d        # запустить
```

## Локальный запуск (без Docker)

```bash
npm install
npm start        # http://localhost:3000
```

Разработка с автоперезагрузкой:

```bash
npm run dev
```

### Запуск в Docker локально (без SSL)

```bash
npm run docker:dev       # http://localhost:3000
npm run docker:dev:down
```

## Возможности

- Регистрация и вход (пароли через `scrypt`, токены HMAC-SHA256)
- Личные чаты, группы и публичные комнаты (автокомната `# general`)
- Обмен сообщениями в реальном времени (Socket.IO)
- Индикатор «печатает…», статус онлайн
- Редактирование и удаление своих сообщений (в комнате — и админ)
- Реакции эмодзи, ответы (reply) с цитированием
- Вложения: изображения (превью, лайтбокс) и файлы (до 10 МБ)
- Аватары и настройки профиля (смена имени, аватара)
- Браузерные уведомления и звук о новых сообщениях
- Счётчики непрочитанных + индикатор в заголовке вкладки
- Поиск по диалогам
- Автоматический HTTPS (Caddy + Let's Encrypt)
- Тёмный адаптивный интерфейс

## Конфигурация

Все параметры установки задаются в `.env` (создаётся установщиком, шаблон — `.env.example`):

| Переменная | Описание | По умолчанию |
|---|---|---|
| `DOMAIN` | Домен мессенджера (для SSL) | — |
| `ACME_EMAIL` | Email для Let's Encrypt | — |
| `HTTPS_PORT` | Внешний порт HTTPS | `443` |
| `MESSENGER_SECRET` | Секрет для подписи токенов | генерируется |
| `PORT` | Внутренний порт приложения | `3000` |

## Тесты

```bash
npm test
```

40+ тестов: хранилище, авторизация, REST API, Socket.IO, группы, аватары, загрузка файлов.

## Структура

```
src/
  server.js   Express + Socket.IO, REST API, реальное время
  store.js    JSON-хранилище (пользователи, диалоги, сообщения, прочтения)
  auth.js     Хэширование паролей и токены
public/
  index.html  Разметка
  style.css   Стили
  app.js      Клиентская логика
test/         Тесты (node:test)
Dockerfile            Образ приложения
docker-compose.yml    Прод-стек (app + Caddy + SSL)
docker-compose.dev.yml Локальный стек (без SSL)
Caddyfile             Конфиг прокси и авто-SSL
install.sh            Интерактивный self-hosted установщик
get.sh                Загрузчик-установщик одной командой
.github/workflows/    CI и релизы (образ в GHCR + установщики в Releases)
```

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/register` | Регистрация |
| POST | `/api/login` | Вход |
| GET | `/api/me` | Текущий пользователь |
| PATCH | `/api/me` | Обновить профиль (имя, аватар) |
| GET | `/api/users` | Список пользователей |
| GET | `/api/conversations` | Диалоги пользователя |
| POST | `/api/conversations` | Создать DM (`dm`), комнату (`room`) или группу (`group`) |
| POST | `/api/conversations/:id/members` | Добавить участника в группу |
| DELETE | `/api/conversations/:id/members/:userId` | Убрать участника / выйти |
| GET | `/api/conversations/:id/messages` | История сообщений |
| POST | `/api/conversations/:id/messages` | Отправить сообщение |
| POST | `/api/conversations/:id/read` | Отметить прочитанным |
| PATCH | `/api/messages/:id` | Изменить сообщение |
| DELETE | `/api/messages/:id` | Удалить сообщение |
| POST | `/api/messages/:id/reactions` | Поставить/убрать реакцию |
| POST | `/api/upload` | Загрузить файл |
| GET | `/api/files/:name` | Скачать файл |
| GET | `/api/health` | Проверка живости |

### События Socket.IO

**Клиент → сервер:** `message:send`, `message:edit`, `message:delete`, `message:react`, `conversation:open`, `conversation:read`, `typing`

**Сервер → клиент:** `ready`, `message:new`, `message:update`, `message:delete`, `conversation:new`, `conversation:update`, `presence:update`, `typing:update`, `read:update`, `user:update`

## Данные

Хранятся в Docker-томе `data` (`/app/data`): `db.json`, `secret`, `uploads/`.
При локальном запуске — в каталоге `data/` рядом с проектом.

## Лицензия

MIT — см. [LICENSE](LICENSE).
