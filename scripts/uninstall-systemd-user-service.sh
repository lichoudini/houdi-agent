#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/houdi-agent.service"

systemctl --user disable --now houdi-agent.service 2>/dev/null || true
rm -f "${SERVICE_FILE}"
systemctl --user daemon-reload

echo "Servicio houdi-agent removido."
