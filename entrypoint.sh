#!/bin/bash
set -e

# Persistent storage: symlink config dirs to /data volume.
# Fly machine restarts boot a fresh rootfs from the image, so anything that
# must survive (pi auth/extensions, t3 link credentials, fnox
# age key) has to live under /data.
mkdir -p /data/.pi /data/.config /data/.t3
for d in .pi .config .t3; do
    if [ ! -L ~/$d ] && [ -d ~/$d ]; then
        # Move existing dir to volume if volume is empty
        if [ -z "$(ls -A /data/$d 2>/dev/null)" ]; then
            mv ~/$d/* /data/$d/ 2>/dev/null || true
        fi
        rm -rf ~/$d
    fi
    [ ! -e ~/$d ] && ln -s /data/$d ~/$d
done

# Seed pi agent defaults (global AGENTS.md + settings.json with subagent
# model routing) from the image on first boot. cp -n: existing volume
# state always wins, so a pi-installed extension is never clobbered.
mkdir -p /data/.pi/agent
cp -n /home/agent/pi-defaults/AGENTS.md /data/.pi/agent/AGENTS.md
cp -n /home/agent/pi-defaults/settings.json /data/.pi/agent/settings.json

# Inject fnox age key from Fly secret to expected location.
# (Zach: the key itself is injected, secrets stay encrypted in fnox.toml.)
if [ -n "$FNOX_AGE_KEY" ]; then
    mkdir -p ~/.config/fnox
    printf '%s' "$FNOX_AGE_KEY" > ~/.config/fnox/age.txt
    chmod 600 ~/.config/fnox/age.txt
    echo "fnox age key injected"
else
    echo "WARNING: FNOX_AGE_KEY not set, fnox decryption will fail"
fi

# gh auth for T3: T3's Source Control only trusts `gh auth status`, which reads
# ~/.config/gh/hosts.yml and ignores env-var tokens. Persist the fnox-held
# GITHUB_TOKEN to gh's auth file at boot (0600). Idempotent and self-healing
# on fresh volumes; ~/.config is symlinked to /data above, so it sticks.
# `gh auth login --with-token` is non-interactive and resolves the username.
if [ -n "$FNOX_AGE_KEY" ]; then
    mkdir -p ~/.config/gh
    fnox exec -c /home/agent/fnox.toml -- sh -c '
        if [ -n "$GITHUB_TOKEN" ]; then
            printf %s "$GITHUB_TOKEN" | gh auth login --with-token -h github.com >/dev/null 2>&1 \
                && chmod 600 ~/.config/gh/hosts.yml
        fi'
    echo "gh auth persisted"
fi

# fnox.toml is baked into the image at ~/fnox.toml.
# Launch t3 through `fnox exec` so the server process (and every terminal
# and agent it spawns) inherits decrypted secrets.
# --replace makes t3 PID 1 so container signals behave.

echo "starting t3 serve on 3773 (secrets via fnox)..."
exec fnox exec -c /home/agent/fnox.toml --replace -- t3 serve --port 3773
