# liv-pi-box

Always-on Fly.io coding box for coding from the phone via
[T3 Code Mobile](https://t3.codes), connected through T3 Connect's relay
tunnel (no public Fly service).

## What's on the box

- Ubuntu 24.04, 2 shared CPUs, 2 GB RAM, 10 GB persistent volume (`pi_data` -> `/data`)
- [pi](https://github.com/badlogic/pi) coding agent, logged in to the ChatGPT
  subscription (openai-codex OAuth), + `pi-subagents`, `pi-web-access`,
  `billion-context-pi`
- T3 Code server (`t3 serve --port 3773`), linked via `t3 connect`
- `gh`, `mise`, `age`, `fnox`, `pitchfork`, 1Password CLI
- Secrets: age-encrypted in `fnox.toml`; the age key is injected at boot from
  the `FNOX_AGE_KEY` Fly secret into `~/.config/fnox/age.txt` (never committed)

Machine restarts boot a fresh rootfs from the image, so everything that must
survive (`.pi`, `.config`, `.t3`) lives on `/data` and is symlinked
at boot by `entrypoint.sh`.

## Auto-deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which deploys with
`flyctl deploy --remote-only`. Before deploying, `scripts/deploy-guard.sh`
checks the box for live agent processes (codex, claude, opencode, pi, ...)
via the Fly Machines exec API and **skips the deploy** if any session is
actively working, so a deploy never kills a running agent mid-flight.

Why not T3's own API for this? T3 does expose an HTTP API (its apps talk to
it with bearer tokens from `t3 auth session issue`), but there is no stable
documented "list active sessions" endpoint to lean on. Live agent processes
are the most direct signal of "a session is working right now".

## Dependencies

All tools are pinned in `.mise.toml` and installed in the image with
`mise install`. Self-hosted [Renovate](https://docs.renovatebot.com/)
(`.github/workflows/renovate.yaml`, same pattern as maccrae-infra: the
`renovatebot/github-action` on a Monday schedule with a `RENOVATE_TOKEN`
secret, no GitHub App) opens PRs bumping the pins; merging one to `main`
triggers a deploy.

## Secrets

- `FLY_API_TOKEN` — GitHub Actions secret, used by the deploy workflow.
- `FNOX_AGE_KEY` — Fly secret (set via `fly secrets set`), injected at boot.
  Never committed; `fnox.toml` in this repo carries no encrypted values.
