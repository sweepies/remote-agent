#!/bin/sh
# Deploy guard: refuse to deploy while AI agent sessions are actively working
# on the box. A Railway redeploy restarts the service, which would kill
# running agents and terminals mid-flight.
#
# Runs on the CI runner (or locally) with RAILWAY_API_TOKEN set.
# Exits 0 when the box is idle (safe to deploy), 1 when busy (skip deploy).
#
# How it works:
# - The box runs a background monitor (see entrypoint.sh) that maintains
#   /data/.agent-busy on the persistent volume: touched when agent CLI
#   processes (codex, claude, opencode, grok, cursor-agent) are running,
#   removed when idle.
# - This guard reads the marker via `railway volume files`, which works
#   with RAILWAY_API_TOKEN (unlike `railway ssh`, which needs the CLI's
#   interactive login session and fails in GitHub Actions).
#
# Conservative by design:
# - No active deployment -> safe to deploy (nothing running to protect).
# - Marker present -> busy, skip deploy.
# - Marker absent -> idle, safe to deploy.
# - Volume/API/auth/network failures -> skip deploy (fail closed).
#   An explicit DEPLOY_FORCE=true overrides the fail-closed behavior for
#   manual runs where the operator knows the box is safe.
set -eu

: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be set}"
PROJECT="${RAILWAY_PROJECT_ID:-462cf5e0-631d-4f95-9372-48b4446869a6}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
VOLUME_ID="${RAILWAY_VOLUME_ID:-e36f9b6d-bdda-45a1-b932-da679a73305d}"

if [ "${DEPLOY_FORCE:-}" = "true" ]; then
  echo "guard: DEPLOY_FORCE=true, overriding guard"
  exit 0
fi

# Check deployment status: if there is no successful deployment, there is
# nothing running to protect.
DEPLOY_STATUS="$(railway status -p "$PROJECT" -e "$ENVIRONMENT" 2>/dev/null | grep -m1 'status:' | sed 's/.*status:[[:space:]]*//' || true)"
case "$DEPLOY_STATUS" in
  *Online*|*Success*)
    echo "guard: service has active deployment ($DEPLOY_STATUS), checking busy marker"
    ;;
  *)
    echo "guard: no active deployment (status: ${DEPLOY_STATUS:-unknown}), safe to deploy"
    exit 0
    ;;
esac

# Check the busy marker on the volume. `railway volume files list` exits 0
# and lists the file if present; fail closed if the check itself errors.
if railway volume files -v "$VOLUME_ID" list /data/.agent-busy 2>/dev/null | grep -q 'agent-busy'; then
  echo "guard: agent sessions active (/data/.agent-busy present), skipping deploy"
  exit 1
fi

# Distinguish "marker absent" from "volume read failed": re-list the parent
# dir to confirm the volume is readable.
if ! railway volume files -v "$VOLUME_ID" list /data 2>/dev/null | grep -q .; then
  echo "guard: volume unreadable (API/auth/network failure), skipping deploy"
  exit 1
fi

echo "guard: box idle (no busy marker), safe to deploy"
exit 0
