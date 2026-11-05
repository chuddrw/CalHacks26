#!/usr/bin/env bash
# scripts/seed-workspace.sh: fill YOUR empty workspace repo (e.g. OrkioDemo) with the demo project the agents edit.
#   scripts/seed-workspace.sh https://github.com/<you>/OrkioDemo.git
# Create the empty repo on github.com first (no README). It copies the demo project's `orchestrator` branch
# (it has cowork.owners.json, which the orchestrator needs) and pushes it as both `main` and `orchestrator`.
# It never force-pushes, never copies wip/* or cowork/* branches, and uses your own git credentials.
set -euo pipefail
TARGET="${1:?usage: scripts/seed-workspace.sh <empty-repo-url>}"
SOURCE="${SEED_SOURCE:-https://github.com/chuddrw/CalHacks26-Demo.git}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
git clone -q --branch orchestrator "$SOURCE" "$DIR/seed"
cd "$DIR/seed"
test -f cowork.owners.json || { echo "source has no cowork.owners.json; refusing" >&2; exit 1; }
git remote add target "$TARGET"
git push target orchestrator:orchestrator orchestrator:main
echo "Seeded $TARGET (branches: main, orchestrator). Agents a, b, c, d are defined in cowork.owners.json."
