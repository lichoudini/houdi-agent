#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${PROJECT_DIR}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${BACKUP_ROOT}/houdi-config-${STAMP}"

mkdir -p "${OUT_DIR}"

sanitize_env() {
  local src="$1"
  local dst="$2"

  if [[ ! -f "${src}" ]]; then
    cat >"${dst}" <<'EOF'
# .env no encontrado al momento del export.
EOF
    return
  fi

  while IFS= read -r line; do
    if [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "${line}" >>"${dst}"
      continue
    fi

    if [[ "${line}" != *"="* ]]; then
      printf '%s\n' "${line}" >>"${dst}"
      continue
    fi

    key="${line%%=*}"
    case "${key}" in
      TELEGRAM_BOT_TOKEN|OPENAI_API_KEY)
        printf '%s=__REDACTED__\n' "${key}" >>"${dst}"
        ;;
      *)
        printf '%s\n' "${line}" >>"${dst}"
        ;;
    esac
  done <"${src}"
}

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "${src}" ]]; then
    cp "${src}" "${dst}"
  fi
}

echo "Exportando configuración crítica a: ${OUT_DIR}"

if systemctl cat houdi-agent.service >"${OUT_DIR}/systemd-houdi-agent.service.txt" 2>/dev/null; then
  :
elif [[ -r /etc/systemd/system/houdi-agent.service ]]; then
  cp /etc/systemd/system/houdi-agent.service "${OUT_DIR}/systemd-houdi-agent.service.txt"
else
  cat >"${OUT_DIR}/systemd-houdi-agent.service.txt" <<'EOF'
# No se pudo leer la unidad con systemctl cat ni desde /etc/systemd/system/houdi-agent.service
EOF
fi

if systemctl show houdi-agent.service >"${OUT_DIR}/systemd-houdi-agent.show.txt" 2>/dev/null; then
  :
else
  cat >"${OUT_DIR}/systemd-houdi-agent.show.txt" <<'EOF'
# No se pudo ejecutar systemctl show houdi-agent.service (bus no accesible en este entorno)
EOF
fi

sanitize_env "${PROJECT_DIR}/.env" "${OUT_DIR}/env.redacted"
copy_if_exists "${PROJECT_DIR}/.env.example" "${OUT_DIR}/env.example"

mkdir -p "${OUT_DIR}/agents"
copy_if_exists "${PROJECT_DIR}/agents/admin.json" "${OUT_DIR}/agents/admin.json"
copy_if_exists "${PROJECT_DIR}/agents/operator.json" "${OUT_DIR}/agents/operator.json"

cat >"${OUT_DIR}/manual-root-backup.txt" <<'EOF'
Archivos root que no siempre son legibles sin privilegios:

1) /etc/sudoers.d/houdi-agent-reboot
   Backup recomendado:
   sudo cp /etc/sudoers.d/houdi-agent-reboot ./sudoers-houdi-agent-reboot
   sudo chmod 600 ./sudoers-houdi-agent-reboot

2) /etc/systemd/system/houdi-agent.service
   Backup recomendado:
   sudo cp /etc/systemd/system/houdi-agent.service ./houdi-agent.service.root-copy
EOF

(
  cd "${OUT_DIR}"
  find . -type f ! -name 'SHA256SUMS.txt' -print0 \
    | sort -z \
    | xargs -0 sha256sum >"${OUT_DIR}/SHA256SUMS.txt"
)

cat >"${OUT_DIR}/README.txt" <<EOF
Houdi Agent config export

Created: $(date -Is)
Source: ${PROJECT_DIR}

Contenido:
- systemd-houdi-agent.service.txt
- systemd-houdi-agent.show.txt
- env.redacted
- env.example
- agents/admin.json
- agents/operator.json
- manual-root-backup.txt
- SHA256SUMS.txt

Nota:
- env.redacted reemplaza TELEGRAM_BOT_TOKEN y OPENAI_API_KEY por __REDACTED__.
- manual-root-backup.txt incluye comandos para copiar archivos root-only.
EOF

echo "Export completo."
echo "Ruta: ${OUT_DIR}"
