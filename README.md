# remote-agent

Always-on Railway coding box for coding from the phone via
[T3 Code Mobile](https://t3.codes), connected through T3 Connect's relay
tunnel (no public ingress).

## What's on the box

- Ubuntu 24.04 on Railway, persistent volume (`remote-agent-data` -> `/data`)
- [Codex CLI](https://github.com/openai/codex) coding agent, logged in to the
  ChatGPT subscription. Subagent model routing: `default` and `worker` on
  `gpt-6.1-sol` (high reasoning), `explorer` on `gpt-6-luna` (medium)
- T3 Code server (`t3 serve --port 3773`), linked via `t3 connect`
- `gh`, `mise`, `age`, `fnox`, `pitchfork`, 1Password CLI, Entire CLI, bun
- Secrets: age-encrypted in `fnox.toml`; the age key is injected at boot from
  the `FNOX_AGE_KEY` Railway variable into `~/.config/fnox/age.txt` (never committed)

Service restarts boot a fresh rootfs from the image, so everything that must
survive (`.codex`, `.config`, `.t3`) lives on `/data` and is symlinked
at boot by `entrypoint.sh`.

## Deploying

Infrastructure is declared in `alchemy.run.ts` and was provisioned with
[alchemy](https://alchemy.run): `Railway.Project` + `Railway.Service` +
`Railway.Volume` mounted at `/data`. Deploys are now Railway-native: the
service is connected to this repo in the Railway dashboard and **builds the
image from `./Dockerfile` and deploys on every push to `main`**, no GitHub
Action involved.

Note: with Railway-native deploys there is no deploy guard, so pushing to
`main` restarts the box even if an agent session is working. Don't push
while something is running unless you mean it.

Why not T3's own API for a guard? T3 does expose an HTTP API (its apps talk
to it with bearer tokens from `t3 auth session issue`), but there is no stable
documented "list active sessions" endpoint to lean on. Live agent processes
are the most direct signal of "a session is working right now".

Deploy state lives in alchemy's Cloudflare-backed state store
(`Cloudflare.state()`), so CI and local runs share it. The first deploy
bootstraps the state-store Worker into the Cloudflare account (one-time).

## Dependencies

Box tools float on `latest` in `.mise.toml` and are installed in the image
with `mise install`. The alchemy deploy dependencies (`package.json`:
`alchemy`, `effect`, `@effect/platform-*`) are versioned normally, and
self-hosted [Renovate](https://docs.renovatebot.com/)
(`.github/workflows/renovate.yaml`, same pattern as maccrae-infra: the
`renovatebot/github-action` on a Monday schedule with a `RENOVATE_TOKEN`
secret, no GitHub App) opens PRs bumping them.

## Secrets

Railway service variables (set in the dashboard; they persist across
Railway-triggered deploys):

- `FNOX_AGE_KEY` — age key for `fnox.toml`, copied into
  `~/.config/fnox/age.txt` at boot by `entrypoint.sh`. Never committed.

- `RENOVATE_TOKEN` — Zach's PAT, for the self-hosted Renovate workflow
  (`.github/workflows/renovate.yaml`, same pattern as maccrae-infra: the
  `renovatebot/github-action` on a Monday schedule, no GitHub App).
