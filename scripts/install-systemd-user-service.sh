#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/houdi-agent.service"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
RESTART_POLICY="${RESTART_POLICY:-on-failure}"
RESTART_SEC="${RESTART_SEC:-5}"
START_LIMIT_INTERVAL="${START_LIMIT_INTERVAL:-60}"
START_LIMIT_BURST="${START_LIMIT_BURST:-5}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "No se encontró node en PATH."
  exit 1
fi

mkdir -p "${SERVICE_DIR}"

cd "${PROJECT_DIR}"

echo "[1/4] Compilando proyecto..."
npm run build

echo "[2/4] Escribiendo servicio systemd user en ${SERVICE_FILE}..."
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

echo "[3/4] Recargando y habilitando servicio..."
systemctl --user daemon-reload
systemctl --user enable --now houdi-agent.service

echo "[4/4] Estado del servicio:"
systemctl --user status houdi-agent.service --no-pager || true

echo
echo "Instalación completada."
echo "Política de restart: ${RESTART_POLICY} (sec=${RESTART_SEC}, burst=${START_LIMIT_BURST}/${START_LIMIT_INTERVAL}s)"
echo "Para que arranque aun sin sesión abierta tras reboot, habilita linger:" 
echo "  sudo loginctl enable-linger ${USER}"
echo
echo "Si tenías 'npm run dev' activo, deténlo para evitar conflicto de instancia única."
