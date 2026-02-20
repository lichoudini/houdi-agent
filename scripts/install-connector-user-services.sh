#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Aviso: install-connector-user-services.sh está deprecado; usando install-lim-user-services.sh"
exec bash "${SCRIPT_DIR}/install-lim-user-services.sh" "$@"
