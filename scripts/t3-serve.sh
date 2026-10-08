#!/bin/sh
# Foreground entry point for the Box init command and manual starts.
set -eu
umask 077
unset FNOX_AGE_KEY FNOX_AGE_KEY_FILE REMOTE_AGE_KEY
cd "$HOME"
exec "$HOME/.local/bin/mise" exec -- t3 serve \
    --host 0.0.0.0 --port 3773 --base-dir /workspace/home/.t3 "$@"
