FROM ubuntu:24.04

# Base dependencies
RUN apt-get update && apt-get install -y \
    curl git sudo ca-certificates xz-utils libatomic1 bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Agent user (no root for daily work)
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER agent
WORKDIR /home/agent

# mise (package manager for everything else)
RUN curl https://mise.run | sh
ENV PATH="/home/agent/.local/bin:/home/agent/.local/share/mise/shims:${PATH}"

# All tools come from .mise.toml (pinned; Renovate bumps weekly).
# NOTE on t3: intentionally not via mise. mise has no t3code backend and the
# npm package named "t3" is an unrelated old package.
# Official docs: t3.codes/install.sh
COPY --chown=agent:agent .mise.toml /home/agent/.mise.toml
RUN mise install

# T3 Code CLI via official installer (self-contained binary, no Node needed)
RUN curl -fsSL https://t3.codes/install.sh | sh

# pi extensions: subagents, web access, billion context
# (pi install takes exactly one source per invocation)
RUN pi install npm:pi-subagents && \
    pi install npm:pi-web-access && \
    pi install npm:billion-context-pi

# Encrypted secrets (fnox.toml with age-encrypted values)
# The age key is injected at boot via $FNOX_AGE_KEY -> ~/.config/fnox/age.txt
COPY --chown=agent:agent fnox.toml /home/agent/fnox.toml

# pi agent defaults: global AGENTS.md + settings.json (subagent model routing).
# Seeded into /data/.pi/agent on first boot by entrypoint.sh (cp -n).
COPY --chown=agent:agent pi/ /home/agent/pi-defaults/

# Bootstraps: age key injection, persistent dir symlinks, t3 serve
COPY --chown=agent:agent entrypoint.sh /home/agent/entrypoint.sh
RUN chmod +x /home/agent/entrypoint.sh

EXPOSE 3773

ENTRYPOINT ["/home/agent/entrypoint.sh"]
