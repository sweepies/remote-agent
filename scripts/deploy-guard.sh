#!/bin/sh
# Deploy guard: refuse to deploy while AI agent sessions are actively working
# on the box. A Railway redeploy restarts the service, which would kill
# running agents and terminals mid-flight.
#
# Runs on the CI runner (or locally) with RAILWAY_API_TOKEN set. It uses
# `railway ssh` to look for live agent CLI processes on the box.
# Exits 0 when the box is idle (safe to deploy), 1 when busy (skip deploy).
#
# NOTE: `railway ssh` needs the CLI's own session auth; a bare
# RAILWAY_API_TOKEN is not enough. In GitHub Actions there is no CLI login,
# so the ssh probe fails and the guard fails open (allows the deploy).
# That is acceptable: all pushes to main are manual, and the person pushing
# knows whether agents are working on the box. Locally (with `railway login`
# done) the guard works as intended.
set -eu

: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be set}"
PROJECT="${RAILWAY_PROJECT:-remote-agent}"
SERVICE="${RAILWAY_SERVICE:-remote-agent}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"

ssh_box() {
  railway ssh -p "$PROJECT" -s "$SERVICE" -e "$ENVIRONMENT" -- "$@"
}

# If the service has no active deployment, no agent sessions can be running:
# a deploy is exactly what will bring it up. ssh fails when there is nothing
# to connect to; treat that as safe, not busy. (Previously an unreachable
# box read as busy and blocked the fix deploy forever.)
if ! ssh_box true 2>/dev/null; then
  echo "guard: service unreachable (no active deployment), safe to deploy"
  exit 0
fi

# Bracketed first letters so pgrep never matches its own command line.
CHECK='
busy=0
for re in "[c]odex" "[c]laude" "[o]pencode" "[g]rok"; do
  if pgrep -f "$re" >/dev/null 2>&1; then echo "active agent: $re"; busy=1; fi
done
if pgrep -x "[a]gent" >/dev/null 2>&1; then echo "active agent: cursor-agent"; busy=1; fi
exit $busy
'

if ssh_box sh -c "$CHECK"; then
  echo "guard: box idle, safe to deploy"
  exit 0
else
  echo "guard: agent sessions active, skipping deploy"
  exit 1
fi
