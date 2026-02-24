#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
ENV_FILE="${PROJECT_DIR}/.env"

log() { echo "[install] $*"; }
fail() { echo "[install][error] $*" >&2; exit 1; }

has_flag() {
  local target="$1"
  shift || true
  for arg in "$@"; do
    if [[ "$arg" == "$target" ]]; then
      return 0
    fi
  done
  return 1
}

resolve_setting() {
  local key="$1"
  local from_env="${!key:-}"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return 0
  fi
  if [[ -f "$ENV_FILE" ]]; then
    local from_file
    from_file="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d'=' -f2- || true)"
    if [[ -n "$from_file" ]]; then
      echo "$from_file"
      return 0
    fi
  fi
  echo ""
}

print_help() {
  cat <<'EOF'
Houdi Agent Installer

Uso:
  ./scripts/install-houdi-agent.sh
  ./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build
  ./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build --with-whatsapp-bridge
  ./scripts/install-houdi-agent.sh --help

Qué hace:
  - Ejecuta el wizard de onboarding.
  - Por default usa wizard en modo simple (ideal primera vez).
  - Ayuda a configurar .env, dependencias, build y servicio (opcional).
  - Incluye opciones de bridge Slack/WhatsApp durante el onboarding.
  - Permite instalar bridges automáticamente con flags (one-command install).

Tips:
  - Interactivo + modo simple recomendado para primera instalación.
  - Si querés control total, usa: --wizard-mode advanced
  - En modo --yes, valida variables mínimas antes de ejecutar.

Ayuda avanzada del wizard:
  npm run onboard -- --help

Flags extra del instalador:
  --with-whatsapp-bridge  Instala houdi-whatsapp-bridge.service al terminar
  --with-slack-bridge     Instala houdi-slack-bridge.service al terminar
  --wizard-mode advanced  Muestra todos los parámetros del wizard
EOF
}

if has_flag "--help" "$@" || has_flag "-h" "$@"; then
  print_help
  exit 0
fi

log "Houdi Agent Installer"
log "Entry-point guiado para onboarding + validaciones mínimas."
echo

[[ -n "${NPM_BIN}" ]] || fail "No se encontró npm en PATH."
[[ -n "${NODE_BIN}" ]] || fail "No se encontró node en PATH."
[[ -f "${PROJECT_DIR}/package.json" ]] || fail "No se encontró package.json en ${PROJECT_DIR}."

cd "${PROJECT_DIR}"

node_major="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
  fail "No pude detectar versión de Node.js."
fi
if (( node_major < 22 )); then
  fail "Node.js >=22 requerido. Versión detectada: $("${NODE_BIN}" -v 2>/dev/null || echo desconocida)"
fi

non_interactive=false
if has_flag "--yes" "$@" || has_flag "--non-interactive" "$@"; then
  non_interactive=true
fi

if [[ "$non_interactive" == "true" ]]; then
  log "Modo no interactivo detectado (--yes/--non-interactive)."
  has_flag "--accept-risk" "$@" || fail "Modo --yes requiere --accept-risk."
  telegram_token="$(resolve_setting "TELEGRAM_BOT_TOKEN")"
  telegram_users="$(resolve_setting "TELEGRAM_ALLOWED_USER_IDS")"
  [[ -n "$telegram_token" ]] || fail "Falta TELEGRAM_BOT_TOKEN (env o .env)."
  [[ -n "$telegram_users" ]] || fail "Falta TELEGRAM_ALLOWED_USER_IDS (env o .env)."
  log "Variables mínimas presentes para ejecución no interactiva."
fi

with_slack_bridge=false
with_whatsapp_bridge=false
if has_flag "--with-slack-bridge" "$@"; then
  with_slack_bridge=true
fi
if has_flag "--with-whatsapp-bridge" "$@"; then
  with_whatsapp_bridge=true
fi

if [[ "$with_slack_bridge" == "true" && "$non_interactive" == "true" ]]; then
  slack_bot_token="$(resolve_setting "SLACK_BOT_TOKEN")"
  slack_app_token="$(resolve_setting "SLACK_APP_TOKEN")"
  [[ -n "$slack_bot_token" ]] || fail "Con --with-slack-bridge falta SLACK_BOT_TOKEN (env o .env)."
  [[ -n "$slack_app_token" ]] || fail "Con --with-slack-bridge falta SLACK_APP_TOKEN (env o .env)."
fi

if [[ "$with_whatsapp_bridge" == "true" && "$non_interactive" == "true" ]]; then
  whatsapp_verify_token="$(resolve_setting "WHATSAPP_VERIFY_TOKEN")"
  whatsapp_access_token="$(resolve_setting "WHATSAPP_ACCESS_TOKEN")"
  [[ -n "$whatsapp_verify_token" ]] || fail "Con --with-whatsapp-bridge falta WHATSAPP_VERIFY_TOKEN (env o .env)."
  [[ -n "$whatsapp_access_token" ]] || fail "Con --with-whatsapp-bridge falta WHATSAPP_ACCESS_TOKEN (env o .env)."
fi

echo "Flujo recomendado (interactivo):"
echo "  ./scripts/install-houdi-agent.sh"
echo "  (wizard simple, apto primera instalación)"
echo
echo "Flujo interactivo avanzado (control total):"
echo "  ./scripts/install-houdi-agent.sh --wizard-mode advanced"
echo
echo "Flujo automatizado (sin preguntas):"
echo "  TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_IDS=123456 \\"
echo "  ./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build"
echo
echo "Flujo one-command (bot + bridge WhatsApp):"
echo "  TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_IDS=123456 WHATSAPP_VERIFY_TOKEN=... WHATSAPP_ACCESS_TOKEN=... \\"
echo "  ./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build --with-whatsapp-bridge"
echo

log "Lanzando wizard de onboarding..."
log "Tip: para ver todos los parámetros técnicos usa --wizard-mode advanced."
if ! "${NPM_BIN}" run onboard -- "$@"; then
  echo
  echo "[install][hint] El onboarding falló. Pasos recomendados:"
  echo "  1) Ver ayuda detallada: npm run onboard -- --help"
  echo "  2) Reintentar interactivo: ./scripts/install-houdi-agent.sh"
  echo "  3) Revisar variables en .env (Telegram y OpenAI)."
  exit 1
fi

if [[ "$with_slack_bridge" == "true" ]]; then
  log "Instalando servicio Slack bridge..."
  bash "./scripts/install-systemd-user-slack-bridge.sh"
fi

if [[ "$with_whatsapp_bridge" == "true" ]]; then
  log "Instalando servicio WhatsApp bridge..."
  bash "./scripts/install-systemd-user-whatsapp-bridge.sh"
fi

echo
log "Instalación completada."
echo "Próximos pasos recomendados:"
echo "  1) Ver estado de memoria/contexto: npm run cli -- memory status"
echo "  2) Iniciar servicio (si aplica): systemctl --user status houdi-agent.service --no-pager"
echo "  3) Probar en Telegram con /status"
if [[ "$with_slack_bridge" == "true" ]]; then
  echo "  4) Verificar Slack bridge: systemctl --user status houdi-slack-bridge.service --no-pager"
fi
if [[ "$with_whatsapp_bridge" == "true" ]]; then
  echo "  5) Verificar WhatsApp bridge: systemctl --user status houdi-whatsapp-bridge.service --no-pager"
fi
