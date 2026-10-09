#!/bin/sh
set -eu
umask 077
unset FNOX_AGE_KEY FNOX_AGE_KEY_FILE REMOTE_AGE_KEY
cd "$HOME"
state=/workspace/home/.remote-agent/services
mkdir -p "$state"
exec 9>"$state/relay.lock"
flock -n 9 || exit 0
exec >>"$state/relay.log" 2>&1
"$HOME/.local/bin/mise" exec -- node "$HOME/remote-agent/services/register.mjs" relay "$$"
exec "$HOME/.local/bin/mise" exec -- node "$HOME/remote-agent/relay/server.mjs"
