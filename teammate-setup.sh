#!/usr/bin/env bash
# teammate-setup.sh: get a second laptop onto the Orkio team database, step by step.
#   ./teammate-setup.sh                 checks tools, signs in, shows your PUBLIC identity to send to Catherine
#   ./teammate-setup.sh join <handle>   after Catherine has approved you: joins the team (handle e.g. b)
# It never prints a token and never installs anything by itself.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
DB="${ORKIO_TEAM_DB:-orkio-catherine}"
BRANCH="catherine-branch-update-after-hackathon"

say() { printf '\n▶ %s\n' "$1"; }
ok()  { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1" >&2; }

say "Checking tools"
if ! command -v node >/dev/null 2>&1; then bad "Node is missing. Install Node 24 or newer: https://nodejs.org"; exit 1; fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then bad "Node $(node -v) is too old. Install Node 24 or newer."; exit 1; fi
ok "node $(node -v)"
if ! command -v git >/dev/null 2>&1; then bad "git is missing."; exit 1; fi
ok "git"
if ! command -v spacetime >/dev/null 2>&1; then
  bad "The spacetime CLI is missing. Install it yourself, then run this script again:"
  echo "      curl -sSf https://install.spacetimedb.com | sh" >&2
  exit 1
fi
ok "spacetime CLI"

say "Getting the right code"
git fetch -q origin "$BRANCH" 2>/dev/null || true
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then git checkout "$BRANCH"; fi
git pull -q --ff-only origin "$BRANCH" 2>/dev/null || note="(could not fast-forward; continuing with what you have)"
ok "branch $BRANCH ${note:-}"

say "Signing in to SpacetimeDB"
if ! spacetime login show >/dev/null 2>&1; then
  echo "  A browser window will open. Sign in, then come back here."
  spacetime login
fi
IDENTITY="$(spacetime login show 2>&1 | sed -n 's/^You are logged in as //p' | head -1)"
if [ -z "$IDENTITY" ]; then bad "Could not read your identity. Run 'spacetime login show' and send the 64-character line that follows 'logged in as'."; exit 1; fi
ok "signed in"

if [ "${1:-}" != "join" ]; then
  say "Send this PUBLIC identity to Catherine (it is safe to share; never send a token):"
  echo
  echo "    $IDENTITY"
  echo
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$IDENTITY" | pbcopy; ok "copied to your clipboard"; fi
  echo "  When Catherine says you are approved, run:  ./teammate-setup.sh join <your-handle>   (for example: b)"
  exit 0
fi

HANDLE="${2:-}"
if ! printf '%s' "$HANDLE" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then bad "Give a handle in lowercase letters/digits, e.g.  ./teammate-setup.sh join b"; exit 1; fi

say "Checking that Catherine approved you on $DB"
if ! spacetime sql "$DB" "SELECT * FROM agent" --server https://maincloud.spacetimedb.com >/dev/null 2>&1; then
  bad "You can't read $DB yet. Ask Catherine to run the grant for your identity, then retry."
  exit 1
fi
ok "you can read $DB"

say "Joining the team as '$HANDLE' (installs packages, sets up the workspace and hooks)"
ORKIO_TEAM_DB="$DB" ./run.sh --name "$HANDLE"

say "Final check"
npm run doctor -- --demo ../workspace || true
echo
echo "Done. Tell Catherine the doctor line above."
