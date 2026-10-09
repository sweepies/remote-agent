#!/bin/sh
set -eu
umask 077
unset FNOX_AGE_KEY FNOX_AGE_KEY_FILE REMOTE_AGE_KEY
cd "$HOME"
state=/workspace/home/.remote-agent/services
mkdir -p "$state" /workspace/home/.t3
exec 9>"$state/t3.lock"
flock -n 9 || exit 0
exec >>/workspace/home/.t3/server.log 2>&1
"$HOME/.local/bin/mise" exec -- node "$HOME/remote-agent/services/register.mjs" t3 "$$"
exec "$HOME/.local/bin/mise" exec -- t3 serve \
    --host 127.0.0.1 --port 3773 --base-dir /workspace/home/.t3 "$@"
