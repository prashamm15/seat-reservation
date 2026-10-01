#!/usr/bin/env bash
# Thin wrapper: ./burst.sh <BASE_URL> [extra burst.js flags...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${1:-http://localhost:8080}"
shift || true
node "$SCRIPT_DIR/scripts/burst.js" "$BASE_URL" "$@"
