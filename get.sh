#!/usr/bin/env bash
#
# VibeMessenger — установка одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/ReLiXTs/VibeMessanger/main/get.sh | bash
#
# Скрипт скачивает репозиторий, затем запускает интерактивный установщик,
# который спросит домен и настроит автоматический HTTPS.
#
set -euo pipefail

BOLD="\033[1m"; GREEN="\033[32m"; RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"

REPO="${VIBE_REPO:-https://github.com/ReLiXTs/VibeMessanger.git}"
BRANCH="${VIBE_BRANCH:-main}"
DIR="${VIBE_DIR:-/opt/vibemessenger}"

printf "${CYAN}==>${RESET} Устанавливаю VibeMessenger в ${BOLD}%s${RESET}\n" "$DIR"

if ! command -v git >/dev/null 2>&1; then
  printf "${RED}✖${RESET} Нужен git.\n" >&2
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y git
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache git
  else
    exit 1
  fi
fi

if [ -d "$DIR/.git" ]; then
  printf "${CYAN}==>${RESET} Обновляю существующую установку...\n"
  git -C "$DIR" fetch --all
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
chmod +x install.sh

printf "${GREEN}✔${RESET} Файлы готовы. Запускаю установщик...\n\n"
exec ./install.sh
