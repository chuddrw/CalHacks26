#!/usr/bin/env bash
# run.sh: put this laptop on the team in one command (details: scripts/join.ts).
#   ./run.sh                  join as an agent
#   ./run.sh --orchestrator   agent + orchestrator + dashboard
#   ./run.sh --screen         dashboard only
#   ./run.sh clean [--yes]    throw the workspace away afterwards
# PowerShell without Git Bash: npm run join -- <same options>
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node 24 or newer first: https://nodejs.org" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 24 ]; then
  echo "Node $(node -v) is too old. Install Node 24 or newer." >&2
  exit 1
fi
exec node scripts/join.ts "$@"
