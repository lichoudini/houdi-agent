#!/usr/bin/env bash
set -euo pipefail

log() { echo "[install-system] $*"; }
fail() { echo "[install-system][error] $*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo."
  echo "Ejemplo: sudo ./scripts/install-systemd-system-service.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/houdi-agent.service"
RUNNER_SCRIPT="${PROJECT_DIR}/scripts/start-houdi-agent.sh"
TARGET_USER="${TARGET_USER:-${SUDO_USER:-houdi}}"

log "Instalador Houdi Agent (systemd system scope)"
log "Objetivo: servicio persistente en boot del host."

command -v systemctl >/dev/null 2>&1 || fail "No se encontró systemctl. Este instalador requiere systemd."
if ! id "${TARGET_USER}" >/dev/null 2>&1; then
  fail "No existe el usuario objetivo: ${TARGET_USER}"
fi

TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
TARGET_UID="$(id -u "${TARGET_USER}")"
USER_UNIT_SYMLINK="${TARGET_HOME}/.config/systemd/user/default.target.wants/houdi-agent.service"
USER_UNIT_FILE="${TARGET_HOME}/.config/systemd/user/houdi-agent.service"
RESTART_POLICY="${RESTART_POLICY:-on-failure}"
RESTART_SEC="${RESTART_SEC:-5}"
START_LIMIT_INTERVAL="${START_LIMIT_INTERVAL:-60}"
START_LIMIT_BURST="${START_LIMIT_BURST:-5}"

if [[ ! -x "${RUNNER_SCRIPT}" ]]; then
  fail "No se encontró script ejecutable: ${RUNNER_SCRIPT}. Asegúrate de que exista y tenga permisos de ejecución."
fi

if [[ ! -f "${PROJECT_DIR}/dist/index.js" ]]; then
  fail "No existe ${PROJECT_DIR}/dist/index.js. Compila primero como ${TARGET_USER}: cd ${PROJECT_DIR} && npm run build"
fi

log "[1/5] Escribiendo ${SERVICE_FILE} ..."
cat >"${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Houdi Agent Telegram Bot (System)
Wants=network-online.target
After=network-online.target
RequiresMountsFor=${PROJECT_DIR}
StartLimitIntervalSec=${START_LIMIT_INTERVAL}
StartLimitBurst=${START_LIMIT_BURST}

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${RUNNER_SCRIPT}
Restart=${RESTART_POLICY}
RestartSec=${RESTART_SEC}
TimeoutStopSec=30
KillSignal=SIGTERM
Environment=NODE_ENV=production
Environment=HOME=${TARGET_HOME}
Environment="NODE_OPTIONS=--no-network-family-autoselection --dns-result-order=ipv4first"
NoNewPrivileges=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

log "[2/5] Recargando systemd (system scope) ..."
systemctl daemon-reload

log "[3/5] Evitando conflicto con unidad --user ..."
rm -f "${USER_UNIT_SYMLINK}" || true
if [[ -f "${USER_UNIT_FILE}" ]]; then
  runuser -u "${TARGET_USER}" -- systemctl --user disable --now houdi-agent.service >/dev/null 2>&1 || true
fi
pkill -u "${TARGET_UID}" -f "${PROJECT_DIR}/dist/index.js" >/dev/null 2>&1 || true
rm -f /tmp/houdi-agent.lock || true

log "[4/5] Habilitando e iniciando servicio de sistema ..."
systemctl enable --now houdi-agent.service

log "[5/5] Estado final ..."
systemctl status houdi-agent.service --no-pager --lines=30 || true

echo
log "Instalación completada."
log "Política de restart: ${RESTART_POLICY} (sec=${RESTART_SEC}, burst=${START_LIMIT_BURST}/${START_LIMIT_INTERVAL}s)"
log "Próximos pasos:"
echo "  1) Estado: systemctl status houdi-agent.service --no-pager"
echo "  2) Logs:   sudo journalctl -u houdi-agent.service -f"
echo "  3) Health: en Telegram, ejecutar /status y /doctor"
