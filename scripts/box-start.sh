#!/bin/sh
# Upstash Init Command: start both services after the Box resumes.
set -eu
umask 077
cd "$HOME"
mkdir -p /workspace/home/.t3 /workspace/home/.tailscale
chmod 0700 /workspace/home/.t3 /workspace/home/.tailscale
setsid nohup "$HOME/.local/bin/remote-agent-tailscaled" \
    > /workspace/home/.tailscale/daemon.log 2>&1 < /dev/null &
setsid nohup "$HOME/.local/bin/remote-agent-t3" \
    > /workspace/home/.t3/server.log 2>&1 < /dev/null &
