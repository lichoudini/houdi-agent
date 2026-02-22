#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/houdi-agent.service"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
RESTART_POLICY="${RESTART_POLICY:-on-failure}"
RESTART_SEC="${RESTART_SEC:-5}"
START_LIMIT_INTERVAL="${START_LIMIT_INTERVAL:-60}"
START_LIMIT_BURST="${START_LIMIT_BURST:-5}"

log() { echo "[install-user] $*"; }
fail() { echo "[install-user][error] $*" >&2; exit 1; }

log "Instalador Houdi Agent (systemd --user)"
log "Objetivo: dejar el agente persistente para el usuario ${USER}."

[[ -n "${NODE_BIN}" ]] || fail "No se encontró node en PATH."
[[ -n "${NPM_BIN}" ]] || fail "No se encontró npm en PATH."
command -v systemctl >/dev/null 2>&1 || fail "No se encontró systemctl. Este instalador requiere systemd."
[[ -f "${PROJECT_DIR}/package.json" ]] || fail "No se encontró package.json en ${PROJECT_DIR}."

mkdir -p "${SERVICE_DIR}"

cd "${PROJECT_DIR}"

log "[1/4] Compilando proyecto..."
"${NPM_BIN}" run build

log "[2/4] Escribiendo servicio systemd user en ${SERVICE_FILE}..."
cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Houdi Agent Telegram Bot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=${START_LIMIT_INTERVAL}
StartLimitBurst=${START_LIMIT_BURST}

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} ${PROJECT_DIR}/dist/index.js
Restart=${RESTART_POLICY}
RestartSec=${RESTART_SEC}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SERVICE

log "[3/4] Recargando y habilitando servicio..."
systemctl --user daemon-reload
systemctl --user enable --now houdi-agent.service

log "[4/4] Estado del servicio:"
systemctl --user status houdi-agent.service --no-pager || true

echo
log "Instalación completada."
log "Política de restart: ${RESTART_POLICY} (sec=${RESTART_SEC}, burst=${START_LIMIT_BURST}/${START_LIMIT_INTERVAL}s)"
log "Próximos pasos:"
echo "  1) Estado: systemctl --user status houdi-agent.service --no-pager"
echo "  2) Logs:   journalctl --user -u houdi-agent.service -f"
echo "  3) Arranque tras reboot sin sesión: sudo loginctl enable-linger ${USER}"
echo "  4) Si tenías 'npm run dev' activo, detenelo para evitar conflicto de instancia única."
