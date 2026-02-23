#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/houdi-whatsapp-bridge.service"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
RESTART_POLICY="${RESTART_POLICY:-on-failure}"
RESTART_SEC="${RESTART_SEC:-5}"
START_LIMIT_INTERVAL="${START_LIMIT_INTERVAL:-60}"
START_LIMIT_BURST="${START_LIMIT_BURST:-5}"

log() { echo "[install-whatsapp-user] $*"; }
fail() { echo "[install-whatsapp-user][error] $*" >&2; exit 1; }

[[ -n "${NPM_BIN}" ]] || fail "No se encontró npm en PATH."
[[ -n "${NODE_BIN}" ]] || fail "No se encontró node en PATH."
command -v systemctl >/dev/null 2>&1 || fail "No se encontró systemctl. Este instalador requiere systemd."
[[ -f "${PROJECT_DIR}/package.json" ]] || fail "No se encontró package.json en ${PROJECT_DIR}."
[[ -f "${PROJECT_DIR}/.env" ]] || fail "No se encontró .env en ${PROJECT_DIR}."

mkdir -p "${SERVICE_DIR}"
cd "${PROJECT_DIR}"

log "Instalador WhatsApp bridge (systemd --user)"
log "Escribe ${SERVICE_FILE}"

cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Houdi WhatsApp Bridge
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=${START_LIMIT_INTERVAL}
StartLimitBurst=${START_LIMIT_BURST}
[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NPM_BIN} run whatsapp:bridge
Restart=${RESTART_POLICY}
RestartSec=${RESTART_SEC}
Environment=NODE_ENV=production
Environment=PATH=$(dirname "${NODE_BIN}"):/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable --now houdi-whatsapp-bridge.service

log "Servicio instalado."
echo "  1) Estado: systemctl --user status houdi-whatsapp-bridge.service --no-pager"
echo "  2) Logs:   journalctl --user -u houdi-whatsapp-bridge.service -f"
echo "  3) Reboot sin sesión: sudo loginctl enable-linger ${USER}"
