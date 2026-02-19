#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo."
  echo "Ejemplo: sudo ./scripts/uninstall-systemd-system-service.sh"
  exit 1
fi

SERVICE_FILE="/etc/systemd/system/houdi-agent.service"

systemctl disable --now houdi-agent.service 2>/dev/null || true
rm -f "${SERVICE_FILE}"
systemctl daemon-reload
systemctl reset-failed houdi-agent.service 2>/dev/null || true

echo "Servicio de sistema houdi-agent removido."
