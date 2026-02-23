#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-houdi-agent.service}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
ADMIN_AGENT_FILE="${PROJECT_DIR}/agents/admin.json"
APP_ENTRY="${PROJECT_DIR}/dist/index.js"

pass_count=0
warn_count=0
fail_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf '[PASS] %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  printf '[WARN] %s\n' "$1"
}

fail() {
  fail_count=$((fail_count + 1))
  printf '[FAIL] %s\n' "$1"
}

echo "== Houdi Agent post-reboot check =="
echo "Fecha: $(date -Is)"
echo "Servicio: ${SERVICE_NAME}"
echo

if systemctl show -p Version --value >/dev/null 2>&1; then
  enabled="$(systemctl is-enabled "${SERVICE_NAME}" 2>/dev/null || true)"
  if [[ "${enabled}" == "enabled" ]]; then
    pass "Servicio habilitado en boot"
  else
    fail "Servicio no está habilitado en boot (is-enabled=${enabled:-unknown})"
  fi

  active="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
  if [[ "${active}" == "active" ]]; then
    pass "Servicio activo"
  else
    fail "Servicio no está activo (is-active=${active:-unknown})"
  fi

  main_pid="$(systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || true)"
  if [[ -n "${main_pid}" && "${main_pid}" =~ ^[0-9]+$ && "${main_pid}" -gt 0 ]]; then
    pass "MainPID válido (${main_pid})"
  else
    fail "MainPID inválido (${main_pid:-empty})"
  fi

  nnp_line="$(systemctl cat "${SERVICE_NAME}" 2>/dev/null | rg -n '^NoNewPrivileges=' | tail -n 1 || true)"
  if [[ -z "${nnp_line}" ]]; then
    warn "No encontré NoNewPrivileges en la unidad"
  elif [[ "${nnp_line}" == *"NoNewPrivileges=false"* ]]; then
    pass "NoNewPrivileges=false (compatible con reboot vía sudo)"
  else
    fail "NoNewPrivileges no está en false (${nnp_line})"
  fi
else
  warn "No se pudo consultar systemd (bus no accesible en este entorno). Se omiten checks de unidad."
  unit_file="/etc/systemd/system/${SERVICE_NAME}"
  unit_wants_symlink="/etc/systemd/system/multi-user.target.wants/${SERVICE_NAME}"
  if [[ -r "${unit_file}" ]]; then
    pass "Archivo de unidad presente (${unit_file})"
    if rg -q '^NoNewPrivileges=false' "${unit_file}"; then
      pass "NoNewPrivileges=false en archivo de unidad"
    else
      fail "NoNewPrivileges no está en false en ${unit_file}"
    fi
  else
    warn "No puedo leer ${unit_file}"
  fi

  if [[ -L "${unit_wants_symlink}" ]]; then
    pass "Symlink de habilitación detectado (${unit_wants_symlink})"
  else
    warn "No encontré symlink de habilitación en ${unit_wants_symlink}"
  fi
fi

proc_count="$(pgrep -fc "${APP_ENTRY}" || true)"
if [[ "${proc_count}" == "1" ]]; then
  pass "Instancia única del bot"
else
  fail "Cantidad inesperada de procesos del bot: ${proc_count} (esperado: 1)"
fi

if [[ -f "${ENV_FILE}" ]]; then
  pass ".env presente"
else
  fail ".env no existe en ${ENV_FILE}"
fi

if [[ -f "${ADMIN_AGENT_FILE}" ]]; then
  pass "agents/admin.json presente"
else
  fail "No existe ${ADMIN_AGENT_FILE}"
fi

if [[ -f "${ENV_FILE}" && -f "${ADMIN_AGENT_FILE}" ]]; then
  reboot_enabled="$(awk -F= '/^ENABLE_REBOOT_COMMAND=/{print $2; exit}' "${ENV_FILE}" | tr -d '[:space:]' || true)"
  reboot_cmd="$(awk -F= '/^REBOOT_COMMAND=/{sub(/^[^=]*=/, "", $0); print $0; exit}' "${ENV_FILE}" || true)"
  reboot_binary="$(printf '%s' "${reboot_cmd}" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')"

  if [[ "${reboot_enabled}" == "true" ]]; then
    pass "ENABLE_REBOOT_COMMAND=true"
  else
    warn "ENABLE_REBOOT_COMMAND no está en true (${reboot_enabled:-unset})"
  fi

  if [[ -n "${reboot_cmd}" ]]; then
    pass "REBOOT_COMMAND configurado (${reboot_cmd})"
  else
    fail "REBOOT_COMMAND vacío o ausente"
  fi

  if [[ -n "${reboot_binary}" ]]; then
    if rg -q "\"${reboot_binary}\"" "${ADMIN_AGENT_FILE}"; then
      pass "El agente admin permite el binario de reboot (${reboot_binary})"
    else
      fail "El agente admin no permite ${reboot_binary}"
    fi
  fi
fi

if journalctl -u "${SERVICE_NAME}" -b --no-pager 2>/dev/null | rg -q 'INFO Starting Telegram bot'; then
  pass "Log de arranque del bot detectado en este boot"
else
  warn "No encontré el mensaje de arranque del bot en logs del boot actual o journal inaccesible"
fi

echo
echo "== Resumen =="
echo "PASS: ${pass_count}"
echo "WARN: ${warn_count}"
echo "FAIL: ${fail_count}"
echo
echo "Smoke test manual en Telegram:"
echo "  /status"
echo "  /agent"
echo "  /agent set admin"
echo "  /reboot status"
echo "  /agent set operator"

if [[ "${fail_count}" -gt 0 ]]; then
  exit 1
fi
