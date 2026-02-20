#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${LIM_APP_DIR:-${CONNECTOR_APP_DIR:-./lim-app}}"
APP_DIR="$(realpath "${APP_DIR}")"
SERVICE_DIR="${HOME}/.config/systemd/user"
APP_SERVICE="${LIM_APP_SERVICE:-${CONNECTOR_RETRIEVER_SERVICE:-houdi-lim-app.service}}"
TUNNEL_SERVICE="${LIM_TUNNEL_SERVICE:-${CONNECTOR_CLOUDFLARED_SERVICE:-houdi-lim-tunnel.service}}"
STACK_TARGET="houdi-lim-stack.target"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
TUNNEL_BIN="${TUNNEL_BIN:-$(command -v cloudflared || true)}"
TUNNEL_CONFIG="${LIM_TUNNEL_CONFIG:-${CONNECTOR_TUNNEL_CONFIG:-${APP_DIR}/cloudflared/config.yml}}"

if [[ -z "${NPM_BIN}" ]]; then
  echo "No se encontro npm en PATH."
  exit 1
fi

if [[ -z "${TUNNEL_BIN}" ]]; then
  echo "No se encontro binario de tunel en PATH (default: cloudflared)."
  exit 1
fi

if [[ ! -d "${APP_DIR}" ]]; then
  echo "No existe LIM_APP_DIR: ${APP_DIR}"
  exit 1
fi

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "No existe package.json en ${APP_DIR}."
  exit 1
fi

if [[ ! -f "${TUNNEL_CONFIG}" ]]; then
  echo "No existe config de tunel: ${TUNNEL_CONFIG}"
  exit 1
fi

mkdir -p "${SERVICE_DIR}"

APP_UNIT_PATH="${SERVICE_DIR}/${APP_SERVICE}"
TUNNEL_UNIT_PATH="${SERVICE_DIR}/${TUNNEL_SERVICE}"
STACK_TARGET_PATH="${SERVICE_DIR}/${STACK_TARGET}"

NODE_PATH_HINT="$(dirname "${NPM_BIN}")"

cat > "${APP_UNIT_PATH}" <<UNIT
[Unit]
Description=Houdi LIM App
After=network-online.target
Wants=network-online.target
PartOf=${STACK_TARGET}

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NPM_BIN} start
Restart=always
RestartSec=5
TimeoutStopSec=30
Environment=NODE_ENV=production
Environment=PATH=${NODE_PATH_HINT}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT

cat > "${TUNNEL_UNIT_PATH}" <<UNIT
[Unit]
Description=Houdi LIM Tunnel
After=network-online.target ${APP_SERVICE}
Wants=network-online.target
Requires=${APP_SERVICE}
PartOf=${STACK_TARGET}

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${TUNNEL_BIN} tunnel --no-autoupdate --config ${TUNNEL_CONFIG} run
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT

cat > "${STACK_TARGET_PATH}" <<UNIT
[Unit]
Description=Houdi LIM Stack
Wants=${APP_SERVICE} ${TUNNEL_SERVICE}
After=${APP_SERVICE} ${TUNNEL_SERVICE}

[Install]
WantedBy=default.target
UNIT

echo "[1/4] Recargando systemd --user..."
systemctl --user daemon-reload

echo "[2/4] Habilitando stack..."
systemctl --user enable ${APP_SERVICE} ${TUNNEL_SERVICE} ${STACK_TARGET} >/dev/null

echo "[3/4] Reiniciando stack..."
systemctl --user restart ${APP_SERVICE} ${TUNNEL_SERVICE} || true
systemctl --user start ${STACK_TARGET}

echo "[4/4] Estado final:"
systemctl --user status "${APP_SERVICE}" --no-pager --lines=20 || true
systemctl --user status "${TUNNEL_SERVICE}" --no-pager --lines=20 || true

echo
echo "Instalacion completada."
echo "Si quieres que arranque aun sin sesion grafica luego de reboot, habilita linger:"
echo "  sudo loginctl enable-linger ${USER}"
