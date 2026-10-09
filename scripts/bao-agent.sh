#!/bin/sh
set -eu
set +x
umask 077
unset BAO_TOKEN VAULT_TOKEN
export BAO_ADDR=https://bao.maccrae.family
cd "$HOME"
state=/workspace/home/.remote-agent/services
mkdir -p "$state"
exec 9>"$state/bao.lock"
flock -n 9 || exit 0
exec >>"$state/bao.log" 2>&1
mise="$HOME/.local/bin/mise"
"$mise" run remote-agent-bao-config
"$mise" exec -- node "$HOME/remote-agent/services/register.mjs" bao "$$"
exec "$mise" exec -- node "$HOME/remote-agent/services/bao-service.mjs"
