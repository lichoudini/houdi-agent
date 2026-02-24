#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"
git config core.hooksPath .githooks

echo "Hooks instalados: core.hooksPath=.githooks"
echo "Pre-push activo: ejecutará repo guard antes de push."
