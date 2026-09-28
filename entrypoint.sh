#!/bin/bash
set -e

# Try to name this box remote-agent: T3 Connect derives the environment
# display name from the machine hostname, and there is no rename flag
# (pingdotgg/t3code#5623). Best-effort only; harmless if the container
# lacks the capability. Non-fatal under set -e.
if sudo -n hostname remote-agent 2>/dev/null; then
    echo "hostname set to remote-agent"
else
    echo "could not set hostname (non-fatal), T3 may show a generated name"
fi

# Persistent storage: symlink config dirs to /data volume.
# Railway restarts boot a fresh rootfs from the image, so anything that
# must survive (codex login, t3 link credentials, agent
# workdirs) has to live under /data.
# The Railway volume mounts root-owned; take ownership so the agent user
# can write. (sudo is NOPASSWD for agent.)
sudo mkdir -p /data/.codex /data/.config /data/.t3
sudo chown -R agent:agent /data
mkdir -p /data/.codex /data/.config /data/.t3
for d in .codex .config .t3; do
    if [ ! -L ~/$d ] && [ -d ~/$d ]; then
        # Move existing dir to volume if volume is empty
        if [ -z "$(ls -A /data/$d 2>/dev/null)" ]; then
            mv ~/$d/* /data/$d/ 2>/dev/null || true
        fi
        rm -rf ~/$d
    fi
    [ ! -e ~/$d ] && ln -s /data/$d ~/$d
done

# Seed codex defaults (config.toml + custom agents with per-agent model
# routing) from the image on first boot. cp -n: existing volume state always
# wins, so edits made through T3 are never clobbered.
mkdir -p /data/.codex/agents
cp -n /home/agent/codex-defaults/config.toml /data/.codex/config.toml
for f in /home/agent/codex-defaults/agents/*.toml; do
    cp -n "$f" /data/.codex/agents/
done

# Inject fnox age key from the Railway variable to the expected location.
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
# Notes:
# - `gh auth login --with-token` is non-interactive and resolves the username.
# - `env -u GITHUB_TOKEN` is required: gh refuses to write hosts.yml (exit 1)
#   when GITHUB_TOKEN is already in the environment, which fnox exec always sets.
# - Wrapped in if/else so a failure here can never kill the boot (set -e).
if [ -n "$FNOX_AGE_KEY" ]; then
    mkdir -p ~/.config/gh
    if fnox exec -c /home/agent/fnox.toml -- sh -c '
        [ -n "$GITHUB_TOKEN" ] || exit 0
        printf %s "$GITHUB_TOKEN" | env -u GITHUB_TOKEN gh auth login --with-token -h github.com >/dev/null 2>&1
    '; then
        chmod 600 ~/.config/gh/hosts.yml 2>/dev/null || true
        echo "gh auth persisted"
    else
        echo "WARNING: gh auth persistence failed (non-fatal), continuing boot"
    fi
fi

# git credential helper for T3's Source Control: T3 clones over https with
# terminal prompts disabled, so git needs non-interactive credentials. Point
# git at `gh auth git-credential`, which serves the hosts.yml token persisted
# above. The mise shim path is used instead of the version-pinned gh binary
# so gh upgrades don't break it. ~/.gitconfig is not on the /data volume, so
# this must run at every boot. Non-fatal under set -e.
if git config --global --replace-all credential.https://github.com.helper "!$HOME/.local/share/mise/shims/gh auth git-credential" 2>/dev/null; then
    echo "git credential helper set"
else
    echo "WARNING: git credential helper setup failed (non-fatal), continuing boot"
fi

# fnox.toml is baked into the image at ~/fnox.toml.
# Launch t3 through `fnox exec` so the server process (and every terminal
# and agent it spawns) inherits decrypted secrets.
# --replace makes t3 PID 1 so container signals behave.

# Tailscale: join the tailnet as tag:remote-agent so the box can mint tsiam
# tokens (tsiam -> Pocket ID -> AWS STS for test VMs) and reach those VMs
# over the tailnet. State persists on /data so the node identity survives
# restarts and re-auth is rare. Railway containers usually lack /dev/net/tun,
# so fall back to userspace networking with a local SOCKS5 proxy and route
# tailnet SSH through it. Non-fatal under set -e: every step is guarded.
if [ -n "$FNOX_AGE_KEY" ]; then
    sudo mkdir -p /data/tailscale
    sudo chown -R agent:agent /data/tailscale
    # ln -sfn alone won't replace a real directory (it would nest the link
    # inside it), so remove a non-symlink /var/lib/tailscale first.
    if [ -e /var/lib/tailscale ] && [ ! -L /var/lib/tailscale ]; then
        sudo rm -rf /var/lib/tailscale
    fi
    sudo ln -sfn /data/tailscale /var/lib/tailscale

    TS_MODE="tun"
    if [ ! -c /dev/net/tun ]; then
        TS_MODE="userspace"
    fi
    echo "tailscale mode: $TS_MODE"
    # In userspace mode there is no TUN interface, so tailnet traffic
    # (tsiam, VM SSH) must go through this SOCKS5 proxy. Exported so the
    # agent's shell inherits it; empty in TUN mode.
    if [ "$TS_MODE" = "userspace" ]; then
        export TS_SOCKS5="127.0.0.1:1055"
    else
        export TS_SOCKS5=""
    fi

    if ! pgrep -x tailscaled >/dev/null 2>&1; then
        if [ "$TS_MODE" = "tun" ]; then
            sudo tailscaled >/data/tailscale/tailscaled.log 2>&1 &
        else
            sudo tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 >/data/tailscale/tailscaled.log 2>&1 &
        fi
        for i in $(seq 1 30); do
            if [ -S /var/run/tailscale/tailscaled.sock ]; then
                break
            fi
            sleep 1
        done
    fi

    if sudo tailscale status >/dev/null 2>&1; then
        echo "tailscale already up"
    else
        if TS_AUTHKEY="$(fnox exec -c /home/agent/fnox.toml -- sh -c 'printf %s "$TAILSCALE_AUTHKEY"' 2>/dev/null)" && [ -n "$TS_AUTHKEY" ]; then
            echo "joining tailnet as remote-agent..."
            if sudo tailscale up --authkey="$TS_AUTHKEY" --hostname=remote-agent --accept-dns=true; then
                echo "tailscale up"
            else
                echo "WARNING: tailscale up failed (non-fatal), continuing boot"
            fi
        else
            echo "WARNING: TAILSCALE_AUTHKEY unavailable, skipping tailscale up (non-fatal)"
        fi
        unset TS_AUTHKEY
    fi

    # tsiam reachability: direct DNS in TUN mode, SOCKS5 in userspace mode
    # (no TUN interface means system DNS can't see tailnet names).
    if [ "$TS_MODE" = "userspace" ]; then
        if curl -sf --max-time 10 --socks5-hostname 127.0.0.1:1055 -o /dev/null https://tsiam.kitty-atria.ts.net/.well-known/jwks.json; then
            echo "tailnet ok: tsiam reachable via SOCKS5"
        else
            echo "WARNING: tsiam.kitty-atria.ts.net not reachable via SOCKS5 (non-fatal)"
        fi
    elif getent hosts tsiam.kitty-atria.ts.net >/dev/null 2>&1; then
        echo "tailnet DNS ok: tsiam.kitty-atria.ts.net resolves"
    else
        echo "WARNING: tsiam.kitty-atria.ts.net does not resolve (non-fatal)"
    fi

    # AWS test-VM credential chain for the agent (on demand, short-lived).
    # Use the fnox lease instead of running these steps by hand:
    #   eval "$(fnox -c /home/agent/fnox.toml lease create aws --format shell)"
    # The lease runs bin/aws-creds.nu (`mise run aws-creds`):
    #   1. tsiam JWT (5 min): POST https://tsiam.kitty-atria.ts.net/token?resource=https://auth.maccrae.family
    #      with header "X-Tsiam: 1". In userspace mode add:
    #        curl --socks5-hostname "$TS_SOCKS5" (empty in TUN mode, so
    #        ${TS_SOCKS5:+--socks5-hostname "$TS_SOCKS5"} is a no-op there)
    #   2. Exchange at https://auth.maccrae.family/api/oidc/token as client
    #      3b6853b3-e39e-469e-9962-145b9ce285e7 (federated: tsiam subject
    #      remote-agent), grant client_credentials with client_assertion =
    #      the tsiam JWT. Returns a 10-min Pocket ID OIDC token.
    #   3. sts:AssumeRoleWithWebIdentity for
    #      arn:aws:iam::572707774253:role/remote-agent-test-vms with that
    #      token. Role is scoped: us-west-2, AMI ami-08205bb9c49ce7df5,
    #      resources tagged provisioned-by=remote-agent.
    # The daemon caches the lease until it expires, then re-mints.
    # Launching a VM still needs the fnox-held TAILSCALE_VM_AUTHKEY in user
    # data: exactly "TS_AUTHKEY=<key>". The VM joins the tailnet as
    # test-vm-<instance-id> with tag:remote-agent (ephemeral) and Tailscale
    # SSH enabled.

    # SSH to tailnet hosts: direct in TUN mode, via the local SOCKS5 proxy
    # in userspace mode. `tailscale ssh` works in both.
    mkdir -p ~/.ssh
    if [ "$TS_MODE" = "userspace" ] && ! grep -q "kitty-atria.ts.net" ~/.ssh/config 2>/dev/null; then
        cat >> ~/.ssh/config <<'EOF'
Host *.kitty-atria.ts.net
    ProxyCommand nc -X 5 -x 127.0.0.1:1055 %h %p
EOF
        echo "tailnet SSH will use the local SOCKS5 proxy"
    fi
else
    echo "WARNING: FNOX_AGE_KEY not set, skipping tailscale (non-fatal)"
fi

# Agent busy monitor: maintains /data/.agent-busy as a signal for the CI
# deploy guard. The guard cannot SSH into the box from GitHub Actions
# (RAILWAY_API_TOKEN is not enough for `railway ssh`), but it can read
# volume files. This background loop touches the marker when agent CLI
# processes are running, removes it when idle.
(
  while true; do
    busy=0
    for re in codex claude opencode grok; do
      if pgrep -f "$re" >/dev/null 2>&1; then busy=1; break; fi
    done
    if [ "$busy" = 0 ] && pgrep -x agent >/dev/null 2>&1; then busy=1; fi
    if [ "$busy" = 1 ]; then
      touch /data/.agent-busy 2>/dev/null || true
    else
      rm -f /data/.agent-busy 2>/dev/null || true
    fi
    sleep 30
  done
) &
echo "agent busy monitor started"

echo "starting t3 serve on 3773 (secrets via fnox)..."
exec fnox exec -c /home/agent/fnox.toml --replace -- t3 serve --port 3773
