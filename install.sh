#!/usr/bin/env bash
#
# VibeMessenger — self-hosted установщик
# Устанавливает Docker (если нужно), спрашивает домен и почту,
# генерирует секреты и поднимает стек с автоматическим SSL.
#
set -euo pipefail

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
log()  { printf "${CYAN}==>${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}✔${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*"; }
die()  { printf "${RED}✖ %s${RESET}\n" "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

printf "\n${BOLD} VibeMessenger — установка self-hosted${RESET}\n"
printf " Мессенджер с автоматическим HTTPS (Caddy + Let's Encrypt)\n\n"

# ---------- 1. Docker ----------
install_docker() {
  log "Устанавливаю Docker..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://get.docker.com | sh
  else
    die "Нужен curl или wget для установки Docker."
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker || true
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker не найден."
  read -r -p "Установить Docker автоматически? [Y/n] " ans
  case "${ans:-Y}" in
    [Yy]*|"") install_docker ;;
    *) die "Docker обязателен. Установите его и запустите скрипт снова." ;;
  esac
else
  ok "Docker найден: $(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  die "Не найден плагин 'docker compose'. Установите docker-compose-plugin."
fi

# ---------- 2. Ввод параметров ----------
SKIP_ENV=0
if [ -f .env ]; then
  warn "Файл .env уже существует."
  read -r -p "Использовать его без изменений? [Y/n] " keep
  if [[ "${keep:-Y}" =~ ^[Yy]*$|^$ ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
    log "Использую существующий .env (домен: ${DOMAIN:-не задан})"
    SKIP_ENV=1
  fi
fi

if [ "$SKIP_ENV" -eq 0 ]; then
  echo
  printf "${BOLD}Введите параметры установки:${RESET}\n"
  read -r -p "Домен для мессенджера (например chat.example.com): " DOMAIN
  [ -n "$DOMAIN" ] || die "Домен обязателен."
  read -r -p "Email для Let's Encrypt (уведомления об истечении SSL): " ACME_EMAIL
  [ -n "$ACME_EMAIL" ] || die "Email обязателен для выпуска SSL."
  read -r -p "Порт HTTPS [443]: " HTTPS_PORT
  HTTPS_PORT="${HTTPS_PORT:-443}"

  MESSENGER_SECRET="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > .env <<EOF
# VibeMessenger — сгенерировано установщиком $(date -u +%Y-%m-%dT%H:%M:%SZ)
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
HTTPS_PORT=$HTTPS_PORT
MESSENGER_SECRET=$MESSENGER_SECRET
EOF
  chmod 600 .env
  ok "Создан .env с секретами (доступ только владельцу)."
fi

[ -n "${DOMAIN:-}" ] || die "DOMAIN не задан (проверьте .env)."

# ---------- 3. Проверка DNS ----------
PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
RESOLVED_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
if [ -n "$PUBLIC_IP" ] && [ -n "$RESOLVED_IP" ]; then
  if [ "$PUBLIC_IP" = "$RESOLVED_IP" ]; then
    ok "DNS: $DOMAIN → $RESOLVED_IP (совпадает с IP сервера)."
  else
    warn "DNS: $DOMAIN → $RESOLVED_IP, а IP сервера — $PUBLIC_IP."
    warn "Выпуск SSL может не сработать, пока A-запись не будет указывать на этот сервер."
    read -r -p "Продолжить всё равно? [y/N] " go
    [[ "${go:-N}" =~ ^[Yy]$ ]] || die "Остановлено. Настройте DNS и запустите снова."
  fi
else
  warn "Не удалось проверить DNS для $DOMAIN. Убедитесь, что A-запись указывает на этот сервер."
fi

# ---------- 4. Firewall ----------
if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -q "Status: active"; then
    log "Открываю порты 80 и 443 в ufw..."
    ufw allow 80/tcp  >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ok "Порты открыты."
  fi
fi

# ---------- 5. Запуск ----------
log "Собираю образ…"
docker compose build

log "Запускаю контейнеры (Caddy выпустит SSL-сертификат автоматически)…"
docker compose up -d

# ---------- 6. Ожидание SSL ----------
log "Ожидаю готовности приложения…"
for i in $(seq 1 30); do
  if docker compose ps --status running 2>/dev/null | grep -q app; then
    break
  fi
  sleep 2
done

PORT_STR=""; [ "${HTTPS_PORT:-443}" != "443" ] && PORT_STR=":${HTTPS_PORT}"
sleep 3

printf "\n"
ok "VibeMessenger установлен!"
printf "  Открой: ${BOLD}https://%s%s${RESET}\n" "$DOMAIN" "$PORT_STR"
printf "  Логи:   ${CYAN}docker compose logs -f${RESET}\n"
printf "  Стоп:   ${CYAN}docker compose down${RESET}\n\n"
warn "Первый выпуск сертификата может занять до ~1 минуты после старта Caddy."
