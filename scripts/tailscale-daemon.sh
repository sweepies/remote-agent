#!/bin/sh
# Foreground userspace daemon; no root, systemd, or /dev/net/tun required.
set -eu
umask 077
unset FNOX_AGE_KEY FNOX_AGE_KEY_FILE REMOTE_AGE_KEY
cd "$HOME"
state_dir=/workspace/home/.tailscale
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
# Hold the lock for the daemon lifetime, so repeated init commands are safe.
exec 9>"$state_dir/daemon.lock"
flock -n 9 || exit 0
exec "$HOME/.local/bin/mise" exec -- tailscaled \
    --tun=userspace-networking \
    --statedir="$state_dir" \
    --state="$state_dir/tailscaled.state" \
    --socket="$state_dir/tailscaled.sock"
