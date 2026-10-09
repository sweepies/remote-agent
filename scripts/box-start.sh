#!/bin/sh
# Fresh boxes have no launcher yet; the configured init command guards that case.
set -eu
umask 077
cd "$HOME/remote-agent"
exec "$HOME/.local/bin/mise" exec -- node services/init.mjs
