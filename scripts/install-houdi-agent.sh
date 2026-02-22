#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"

log() { echo "[install] $*"; }
fail() { echo "[install][error] $*" >&2; exit 1; }

log "Houdi Agent Installer"
log "Este flujo te guía para configurar .env, instalar dependencias y dejar un servicio opcional."
echo
echo "Flujo recomendado (interactivo):"
echo "  ./scripts/install-houdi-agent.sh"
echo
echo "Flujo automatizado (sin preguntas):"
echo "  TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_IDS=123456 \\"
echo "  ./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build"
echo
echo "Ayuda completa del wizard:"
echo "  npm run onboard -- --help"
echo

[[ -n "${NPM_BIN}" ]] || fail "No se encontró npm en PATH."
[[ -f "${PROJECT_DIR}/package.json" ]] || fail "No se encontró package.json en ${PROJECT_DIR}."

cd "${PROJECT_DIR}"

log "Lanzando wizard de onboarding..."
log "Tip: puedes usar -- --accept-risk para omitir confirmación de riesgo."
"${NPM_BIN}" run onboard -- "$@"
