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

log() { echo "[install-lim] $*"; }
fail() { echo "[install-lim][error] $*" >&2; exit 1; }

log "Instalador stack LIM (app + tunnel, systemd --user)"
log "Objetivo: servicios separados y persistentes por usuario."

[[ -n "${NPM_BIN}" ]] || fail "No se encontró npm en PATH."
[[ -n "${TUNNEL_BIN}" ]] || fail "No se encontró binario de túnel en PATH (default: cloudflared)."
command -v systemctl >/dev/null 2>&1 || fail "No se encontró systemctl. Este instalador requiere systemd."
[[ -d "${APP_DIR}" ]] || fail "No existe LIM_APP_DIR: ${APP_DIR}"
[[ -f "${APP_DIR}/package.json" ]] || fail "No existe package.json en ${APP_DIR}."
[[ -f "${TUNNEL_CONFIG}" ]] || fail "No existe config de túnel: ${TUNNEL_CONFIG}"

log "App dir: ${APP_DIR}"
log "App service: ${APP_SERVICE}"
log "Tunnel service: ${TUNNEL_SERVICE}"
log "Tunnel config: ${TUNNEL_CONFIG}"

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

log "[1/5] Recargando systemd --user..."
systemctl --user daemon-reload

log "[2/5] Habilitando stack..."
systemctl --user enable ${APP_SERVICE} ${TUNNEL_SERVICE} ${STACK_TARGET} >/dev/null

log "[3/5] Reiniciando stack..."
systemctl --user restart ${APP_SERVICE} ${TUNNEL_SERVICE}
systemctl --user start ${STACK_TARGET}

log "[4/5] Verificando estado final..."
systemctl --user status "${APP_SERVICE}" --no-pager --lines=20 || true
systemctl --user status "${TUNNEL_SERVICE}" --no-pager --lines=20 || true

if ! systemctl --user is-active --quiet "${APP_SERVICE}"; then
  fail "El servicio de app (${APP_SERVICE}) no quedó activo."
fi
if ! systemctl --user is-active --quiet "${TUNNEL_SERVICE}"; then
  fail "El servicio de túnel (${TUNNEL_SERVICE}) no quedó activo."
fi

log "[5/5] Stack activo."
echo
log "Instalación completada."
log "Próximos pasos:"
echo "  1) Estado app:    systemctl --user status ${APP_SERVICE} --no-pager"
echo "  2) Estado túnel:  systemctl --user status ${TUNNEL_SERVICE} --no-pager"
echo "  3) Logs app:      journalctl --user -u ${APP_SERVICE} -f"
echo "  4) Logs túnel:    journalctl --user -u ${TUNNEL_SERVICE} -f"
echo "  5) Arranque tras reboot sin sesión: sudo loginctl enable-linger ${USER}"
