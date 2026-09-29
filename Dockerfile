FROM ubuntu:24.04

# Base dependencies
RUN apt-get update && apt-get install -y \
    curl git sudo ca-certificates xz-utils libatomic1 bubblewrap netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Tailscale (tailnet access: tsiam token minting for the AWS flow, SSH to test VMs)
RUN curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && \
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list && \
    apt-get update && apt-get install -y tailscale && rm -rf /var/lib/apt/lists/*

# Agent user (no root for daily work)
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER agent
WORKDIR /home/agent

# mise (package manager for everything else)
RUN curl https://mise.run | sh
ENV PATH="/home/agent/.local/bin:/home/agent/.local/share/mise/shims:${PATH}"

# All tools come from .mise.toml (floating on latest; the image picks up new
# versions on rebuild).
# NOTE on t3: intentionally not via mise. mise has no t3code backend and the
# npm package named "t3" is an unrelated old package.
# Official docs: t3.codes/install.sh
COPY --chown=agent:agent .mise.toml /home/agent/.mise.toml
RUN mise install

# T3 Code CLI via official installer (self-contained binary, no Node needed)
# NOTE: the installer symlinks ~/.local/bin/t3 to a versioned path under
# ~/.t3, but the entrypoint moves ~/.t3 to the persistent volume on first
# boot. When the image ships a newer t3 than the volume has, that symlink
# dangles and boot fails. Keep a real copy of the binary at a stable path.
RUN curl -fsSL https://t3.codes/install.sh | sh && \
    cp "$(readlink -f /home/agent/.local/bin/t3)" /home/agent/.local/bin/t3-bin && \
    ln -sfn /home/agent/.local/bin/t3-bin /home/agent/.local/bin/t3

# codex defaults: config.toml + custom agents (default/worker on gpt-6.1-sol high,
# explorer on gpt-6-luna medium) + skills (aws-test-vms). Seeded into
# /data/.codex on first boot by entrypoint.sh (cp -n).
COPY --chown=agent:agent codex/ /home/agent/codex-defaults/

# Encrypted secrets (fnox.toml with age-encrypted values)
# The age key is injected at boot via $FNOX_AGE_KEY -> ~/.config/fnox/age.txt
COPY --chown=agent:agent fnox.toml /home/agent/fnox.toml

# nu script backing the fnox `aws` lease (mise file task `aws-creds` mints
# short-lived test-VM creds via tsiam -> Pocket ID -> STS)
COPY --chown=agent:agent .mise/ /home/agent/.mise/

# Bootstraps: age key injection, persistent dir symlinks, t3 serve
COPY --chown=agent:agent entrypoint.sh /home/agent/entrypoint.sh
RUN chmod +x /home/agent/entrypoint.sh

EXPOSE 3773

ENTRYPOINT ["/home/agent/entrypoint.sh"]
