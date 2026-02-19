#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

NODE_BIN_CANDIDATE="${NODE_BIN:-}"

if [[ -n "${NODE_BIN_CANDIDATE}" && -x "${NODE_BIN_CANDIDATE}" ]]; then
  NODE_BIN_RESOLVED="${NODE_BIN_CANDIDATE}"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN_RESOLVED="$(command -v node)"
else
  NODE_BIN_RESOLVED="$(
    find "${HOME}/.nvm/versions/node" -mindepth 3 -maxdepth 3 -type f -name node 2>/dev/null \
      | sort -V \
      | tail -n 1
  )"
fi

if [[ -z "${NODE_BIN_RESOLVED:-}" || ! -x "${NODE_BIN_RESOLVED}" ]]; then
  echo "No se encontró un binario de Node ejecutable." >&2
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/dist/index.js" ]]; then
  echo "Falta ${PROJECT_DIR}/dist/index.js. Ejecuta: npm run build" >&2
  exit 1
fi

exec "${NODE_BIN_RESOLVED}" "${PROJECT_DIR}/dist/index.js"
