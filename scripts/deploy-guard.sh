#!/bin/sh
# Deploy guard: refuse to deploy while AI agent sessions are actively working
# on the box. A Fly deploy stops the machine, which would kill running agents
# and terminals mid-flight.
#
# Runs on the CI runner (or locally) with FLY_API_TOKEN set. It uses the Fly
# Machines exec API to look for live agent CLI processes on the box.
# Exits 0 when the box is idle (safe to deploy), 1 when busy (skip deploy).
set -eu

APP="${FLY_APP:-liv-pi-box}"
MACHINE="${FLY_MACHINE:-e82ee5dbd019d8}"
: "${FLY_API_TOKEN:?FLY_API_TOKEN must be set}"

api() {
  curl -sS -m 30 -H "Authorization: Bearer $FLY_API_TOKEN" "$@"
}

# If the machine is known to not be running, no agent sessions can be active:
# a deploy is exactly what will bring it back. (Previously an unreachable
# machine made the exec check fail, which read as "busy" and blocked the
# fix deploy forever.) Unknown state stays conservative (busy).
STATE=$(api "https://api.machines.dev/v1/apps/$APP/machines/$MACHINE" | jq -r '.state // empty')
if [ -n "$STATE" ] && [ "$STATE" != "started" ]; then
  echo "guard: machine state is '$STATE' (not started), safe to deploy"
  exit 0
elif [ -z "$STATE" ]; then
  echo "guard: could not determine machine state, assuming busy"
  exit 1
fi

# Bracketed first letters so pgrep never matches its own sh -c command line.
CHECK='
busy=0
for re in "[c]odex" "[c]laude" "[o]pencode" "[g]rok"; do
  if pgrep -f "$re" >/dev/null 2>&1; then echo "active agent: $re"; busy=1; fi
done
if pgrep -f "[p]i --mode" >/dev/null 2>&1; then echo "active agent: pi"; busy=1; fi
if pgrep -x "[a]gent" >/dev/null 2>&1; then echo "active agent: cursor-agent"; busy=1; fi
exit $busy
'

PAYLOAD=$(jq -n --arg cmd "$CHECK" '{command: ["sh", "-c", $cmd]}')
RESP=$(curl -sS -m 90 -X POST \
  "https://api.machines.dev/v1/apps/$APP/machines/$MACHINE/exec" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "$RESP" | jq -r '.stdout // empty'
EXIT_CODE=$(echo "$RESP" | jq -r '.exit_code // 1')

if [ "$EXIT_CODE" = "0" ]; then
  echo "guard: box idle, safe to deploy"
  exit 0
else
  echo "guard: agent sessions active, skipping deploy"
  exit 1
fi
