#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo."
  echo "Ejemplo: sudo ./scripts/install-systemd-system-service.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/houdi-agent.service"
RUNNER_SCRIPT="${PROJECT_DIR}/scripts/start-houdi-agent.sh"
TARGET_USER="${TARGET_USER:-${SUDO_USER:-houdi}}"

if ! id "${TARGET_USER}" >/dev/null 2>&1; then
  echo "No existe el usuario objetivo: ${TARGET_USER}"
  exit 1
fi

TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
TARGET_UID="$(id -u "${TARGET_USER}")"
USER_UNIT_SYMLINK="${TARGET_HOME}/.config/systemd/user/default.target.wants/houdi-agent.service"
USER_UNIT_FILE="${TARGET_HOME}/.config/systemd/user/houdi-agent.service"

if [[ ! -x "${RUNNER_SCRIPT}" ]]; then
  echo "No se encontró script ejecutable: ${RUNNER_SCRIPT}"
  echo "Asegúrate de que exista y tenga permisos de ejecución."
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/dist/index.js" ]]; then
  echo "No existe ${PROJECT_DIR}/dist/index.js."
  echo "Compila primero como ${TARGET_USER}:"
  echo "  cd ${PROJECT_DIR} && npm run build"
  exit 1
fi

echo "[1/5] Escribiendo ${SERVICE_FILE} ..."
cat >"${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Houdi Agent Telegram Bot (System)
Wants=network-online.target
After=network-online.target
RequiresMountsFor=${PROJECT_DIR}
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${RUNNER_SCRIPT}
Restart=always
RestartSec=3
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

echo "[2/5] Recargando systemd (system scope) ..."
systemctl daemon-reload

echo "[3/5] Evitando conflicto con unidad --user ..."
rm -f "${USER_UNIT_SYMLINK}" || true
if [[ -f "${USER_UNIT_FILE}" ]]; then
  runuser -u "${TARGET_USER}" -- systemctl --user disable --now houdi-agent.service >/dev/null 2>&1 || true
fi
pkill -u "${TARGET_UID}" -f "${PROJECT_DIR}/dist/index.js" >/dev/null 2>&1 || true
rm -f /tmp/houdi-agent.lock || true

echo "[4/5] Habilitando e iniciando servicio de sistema ..."
systemctl enable --now houdi-agent.service

echo "[5/5] Estado final ..."
systemctl status houdi-agent.service --no-pager --lines=30 || true

echo
echo "Instalación completada."
echo "Ver logs: sudo journalctl -u houdi-agent.service -f"
