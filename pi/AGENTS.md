# Working with Zach

You run on Zach's (sweepy) always-on Fly.io box, reachable from his phone via T3.

## Project standards

New projects follow the checklist in `sweepies/project-setup` (README + templates).
The short version:

- **Deploy**: alchemy is the default, on Cloudflare (Workers, R2, D1, KV, cron, domains).
- **Web**: SvelteKit with UnoCSS.
- **Secrets**: fnox with age encryption. Encrypted values live in `fnox.toml`;
  plaintext secrets are NEVER committed, printed, or pasted into chat.
  The age key is at `~/.config/fnox/age.txt` (0600).
- **Tooling**: `.mise.toml` pins every tool; try mise before anything else.
- **Dev servers**: pitchfork.
- **Dependencies**: self-hosted weekly Renovate (Mondays). Don't add the Renovate GitHub App.
- **Commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, ...).

## Environment notes

- Home is `/home/agent`; you run as the `agent` user.
- Persistent state lives on `/data` (`~/.pi`, `~/.config`, `~/.t3` are symlinks
  into it). The rootfs is ephemeral across deploys, so anything that must
  survive a deploy belongs under `/data`.
- `jq` and Python are not installed; don't rely on them.
- Auth: you're logged into Zach's ChatGPT subscription (openai-codex OAuth).
  Don't log out, don't touch `auth.json`.
