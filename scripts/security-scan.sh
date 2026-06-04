#!/usr/bin/env bash
set -euo pipefail

if ! command -v osv-scanner >/dev/null 2>&1; then
  cat >&2 <<'EOF'
osv-scanner is not installed. Install it before running the security scan:

  macOS:  brew install osv-scanner
  other:  https://google.github.io/osv-scanner/installation/

This is the same scanner used by the CI security job.
EOF
  exit 1
fi

exec env TERM=dumb osv-scanner --lockfile=pnpm-lock.yaml </dev/null
