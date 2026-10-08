# Remote agent bootstrap

This project provisions the Upstash Box with **mise 2026.10.3 or newer** and
native bootstrap. Shared configuration comes from the latest published `main`
of <https://github.com/sweepies/dotfiles>, cloned to **`~/dotfiles`**. This
repository owns only remote-specific tools, Pi MCP/skills, and service launchers.
It does not modify the dotfiles repository or manage remote shell startup.

## From the initiating machine

Requirements: mise **2026.10.3+**, OpenSSH, `sshpass`, and
`UPSTASH_BOX_API_KEY` in the environment. No local fnox lookup or remote age-key
input is required. The target needs Git, anonymous HTTPS access to the public
dotfiles repository, access to tool registries, and the Box's existing host-owned
shell/PATH. Shared bootstrap needs no target GitHub credentials or borrowing
relay. Private checkpoint uploads or private packages still require separate
GitHub authorization; 1Password enrollment alone does not grant repository access.
On first connection, verify and accept
the Box's SSH host key normally; the bootstrap does not disable host-key checking.

```sh
# Apply the full bootstrap (including the latest published dotfiles).
mise run bootstrap-remote -- --yes

# Open an interactive shell.
mise run ssh
```

`scripts/box-bootstrap.sh` scopes password authentication to this invocation.
It passes the password through `sshpass -e`, overrides mise's SSH batch mode,
and strips macOS tar metadata when transferring from Darwin. It never writes
the password to a file or includes it in command-line arguments.

## What is installed

- Native `[bootstrap.repos]` clones `~/dotfiles`; native repo update fetches
  latest `main` on every apply, without forced resets of dirty checkouts.
- `mise -C "$HOME/dotfiles" bootstrap --yes` applies the shared mise config,
  static template `.miserc.toml`, Git config, Pi settings, and Git-indexed fnox
  `shared.toml` group, then installs shared tools. No reusable dotfiles wrapper.
- Linux's native `auto_env=true` selects only shared configuration: no Fish,
  Mac overlay, aliases, Homebrew variables, or Secure Enclave plugin.
- `.pi/mcp.json` → `~/.pi/agent/mcp.json`.
- `.pi/agent/skills/` → `~/.pi/agent/skills/`.
- `remote-tools.toml` → `~/.config/mise/conf.d/remote-agent.toml`, containing
  only Go, the Linux 1Password CLI, T3, Tailscale, and the auth/vault/enrollment tasks.
- A fresh machine generates its **own** ordinary age identity and a private,
  regular fnox config importing `./shared.toml`. Neither is mise-managed.
- Global Pi packages via `mise exec -- pi update --extensions`. Secret checking
  and signing-key provisioning happen only during later 1Password enrollment.
- T3 Code pinned through mise's npm backend to
  `0.0.46-nightly.20261007.2774` (the npm `nightly` tag resolved on 2026-10-07).
- `scripts/t3-serve.sh` → `~/.local/bin/remote-agent-t3`, a foreground launcher
  that runs T3 through mise with persistent state under `/workspace/home/.t3`.
- Linux-only Tailscale `1.102.5`, the userspace daemon launcher
  `~/.local/bin/remote-agent-tailscaled`, and `~/.local/bin/remote-agent-start`
  for the Box init command. Tailscale state stays under `/workspace/home/.tailscale`.

Runtime data (`~/.pi/agent/auth.json`, sessions, installed packages, T3 state,
and Tailscale state) is not copied from this machine. Pi package updates are
deliberate. Shared versions—including the Pi pin—come only from dotfiles; T3
stays on its exact nightly pin until deliberately changed in `remote-tools.toml`.
Local npm/git caches, Pi authentication/sessions, old `.pi/settings.json`, the
entire retired `fnox/` deployment, local `fnox.toml`, `.agents`, and `.box` are
excluded from transfer. The legacy local files are retained, but not deployed.

Bootstrap never blindly forces dotfile conflicts or overwrites existing local
fnox state. Before migrating an old Box, inspect and move conflicting legacy
mise/Pi configuration aside. Retire its old two-recipient fnox config and shared
age identity together before generating a fresh pair. Remove only the old
mise-managed Bash activation block if present; this project installs no replacement.
On a valuable Box, back up and reconcile these files first. Do not transfer
Mac identities, encrypted caches, or private signing keys into the source archive.

## Secrets and model authentication

The source of truth is `~/dotfiles/.config/fnox/shared.toml`: references in the
1Password **dev** vault, not committed age ciphertext or recipients. The old
`REMOTE_AGE_KEY` transport and shared two-recipient config are retired. Existing
GitHub, Context7, Cloudflare, and other old references are not automatically
migrated or deployed; add needed references to your 1Password/fnox setup deliberately.

Each rebuilt machine creates a new `~/.config/fnox/age.txt` with `age-keygen`.
Its regular, untracked `~/.config/fnox/config.toml` starts as:

```toml
import = ["./shared.toml"]

[providers.sync-age]
type = "age"
recipients = ["<this machine's age recipient>"]
key_file = "~/.config/fnox/age.txt"
```

Both files are mode `0600`, inside a `0700` directory. Repeat bootstrap preserves
a valid local pair and caches; partial, symlinked, legacy, or mismatched state
fails with a reconciliation message. No Mac Secure Enclave identity is involved.
Never export `FNOX_AGE_KEY`: it overrides provider-specific identities. Remote
mise configuration and launchers unset inherited legacy key variables.

### Enroll when 1Password is ready

Create a 1Password service account scoped to the **dev** vault with both
`read_items` and `write_items` permissions. Service-account permissions are
immutable: replace an existing read-only account rather than expecting a new
command to grant writes. Keep the token outside Git, source archives, command
arguments, and logs; do not paste it into this thread. Bootstrap does not request
or transport the token, sync secrets, or require authentication to complete.

Store the token **once per machine**, in an interactive target SSH terminal:

```sh
cd "$HOME"
~/.local/bin/mise run remote-agent-auth
# Enter the token only at fnox's hidden prompt; it is not echoed or put in argv.
~/.local/bin/mise run remote-agent-enroll
```

The auth task uses native `fnox set` to encrypt `OP_SERVICE_ACCOUNT_TOKEN` with
this machine's existing `sync-age` provider. It is stored in the isolated
`op-auth` profile inside the regular, untracked `~/.config/fnox/config.toml`
(`0600`), not a plaintext token/env file. Its age identity remains `0600`. There
is no new shell startup, token transport, or default Pi/T3 token injection.

Enrollment automatically loads this profile through native `fnox exec`, then
runs non-interactive global sync commands for default secrets and isolated
`git-signing`. Sync confirmation is explicitly disabled so unattended refreshes
actually update the caches. The task then exports the signing
key into a private temporary file, validates it with `ssh-keygen`, and installs
`~/.ssh/git-signing` atomically without overwriting an existing key. Failed
exports leave no partial destination key. Existing regular keys are retained;
rotation requires deliberate replacement. Local cache configuration stays private.

The shared Git config uses OpenSSH signing and this persistent, decrypted,
passphrase-free key (`0600`). After enrollment, signing works across reboots
without an SSH agent, 1Password, fnox startup, or the service-account token.
Any process running as the user can use this exported key; protect the disk and
account accordingly. Before enrollment, signed commits fail because the key is
absent. Register its public key as a GitHub **signing** key:

```sh
ssh-keygen -y -f "$HOME/.ssh/git-signing"
```

After rotating vault items, rerun `~/.local/bin/mise run remote-agent-enroll`;
**do not re-enter the token**. Fresh processes and reboots load the encrypted
credential automatically. Re-enter it through `remote-agent-auth` only to rotate
an expired/revoked token or enroll a rebuilt machine with a new age identity.
Cached default secrets and the signing key continue to work without a vault
connection; test caches without vault authentication to rule out source fallback.

### Agent read/write access to 1Password

Use the persistent vault task for `op` commands or vault-backed fnox operations:

```sh
~/.local/bin/mise run remote-agent-vault -- op item list --vault dev
~/.local/bin/mise run remote-agent-vault -- op item get ITEM_ID --vault dev
# For create/edit, provide sensitive item JSON through stdin, not argv/history.
~/.local/bin/mise run remote-agent-vault -- op item edit ITEM_ID --vault dev
```

The task loads only `op-auth` (`--no-defaults`) and passes the credential only to
the requested command and its children. It forwards arguments/stdin/exit status,
clears stale token and legacy-age overrides, and fails before executing the
command if the saved auth profile is missing. Read/write authorization is still
enforced by the service account's vault permissions; this task grants nothing
beyond them. Avoid logging item values returned by read commands.

Protect the machine and its account: any same-user process with access to the
age identity can decrypt the saved token and use the service account. Profile
isolation prevents accidental environment injection; it is not a sandbox or
protection against a compromised Box. A full rebuild requires one-time token
enrollment again; ordinary restarts and cache refreshes do not.

Pi OAuth credentials are runtime state, not dotfiles. On a fresh Box, use
`mise exec -- pi auth login --provider openai`; existing credentials are not
intentionally overwritten.

## Running Pi and T3 Code

There are two entry points:

1. **Interactive SSH:** `mise run ssh`, then `mise exec -- pi`. The host owns
   shell startup; this project adds no activation block or PATH edits.
2. **T3 Code:** `~/.local/bin/remote-agent-t3` runs `mise exec -- t3 serve`.
   Pi processes launched by T3 inherit that mise-managed PATH, including
   `mise`, `node`, `pi`, and `fnox`. No additional Pi wrapper or login-shell
   shim is needed.

Pi's mise extension activates project toolchains for agent Bash calls when it
detects a project config. Its fnox extension loads secrets from the provisioned
fnox configuration and identity file.

### Tailscale Funnel (primary browser and mobile access)

<https://remote-agent.kitty-atria.ts.net/>

Funnel is authorized and running. This is a **public HTTPS URL**; your phone
needs neither the Tailscale app nor an active Tailscale connection. T3's own
pairing/authentication remains enabled. Verified externally on 2026-10-07:
pairing exchange 200, bearer session authenticated, WebSocket ticket 200, and
WebSocket upgrade 101 with orchestration protocol 2.

Tailscale `1.102.5` is pinned through `aqua:tailscale/tailscale` for Linux only.
The Box has no `/dev/net/tun` or systemd, so
`~/.local/bin/remote-agent-tailscaled` runs an unprivileged userspace daemon.
Its state and socket live under `/workspace/home/.tailscale` (mode `0700`);
the launcher holds a lifetime lock to avoid duplicate daemons. State contains
Tailscale credentials and must not be committed or copied into bootstrap.

The Box init command starts both Tailscale and T3 automatically. Funnel's
background configuration and node identity persist in the Tailscale state
directory; you do not need to reauthorize after an ordinary daemon restart.
Daemon restart was verified: it restored its identity and Funnel configuration
without another login, and external bearer/WebSocket tests passed again.
Reconnection took about a minute on this Box; allow a short warm-up after startup.
A full pause/resume cycle has not been tested.

From interactive SSH, use the explicit socket for administration:

```sh
mise exec -- tailscale --socket=/workspace/home/.tailscale/tailscaled.sock status
mise exec -- tailscale --socket=/workspace/home/.tailscale/tailscaled.sock funnel status

# Only on a fresh Box that has not joined the tailnet:
mise exec -- tailscale --socket=/workspace/home/.tailscale/tailscaled.sock up \
  --hostname=remote-agent --accept-dns=false --accept-routes=false
# After authorizing the Box and enabling Funnel for your tailnet:
mise exec -- tailscale --socket=/workspace/home/.tailscale/tailscaled.sock funnel --bg 3773
```

Funnel requires tailnet MagicDNS, HTTPS, and permission to use Funnel. To pair
an iOS client or browser, run on the Box:

```sh
mise exec -- t3 auth pairing create \
  --base-dir /workspace/home/.t3 \
  --base-url https://remote-agent.kitty-atria.ts.net \
  --ttl 5m --label ios
```

Open the fresh link on your phone and approve the environment import. If the
app retains an old direct environment, remove or replace that entry with the
Funnel address. Treat pairing URLs as passwords. T3 Connect stays disabled;
Funnel provides transport independently of T3's managed Cloudflare tunnel.

### T3 Connect (disabled)

T3 Connect was disabled with `t3 connect unlink --base-dir /workspace/home/.t3`
on 2026-10-07. Remote exposure and agent-activity publishing are off, and the
managed `cloudflared` process has stopped. Stored CLI authorization is retained,
but it does not enable a tunnel on restart. Use the Funnel URL above for
browser and mobile access. The original Upstash preview URL below remains a
browser fallback, but its Authorization-header issue prevents native mobile
access.

The tunnel failed with `endpoint_request_failed`: QUIC timed out and HTTP/2
reported `TLS handshake with edge error: EOF`. The Box already has an
`allow-all` policy. TLS using SNI `h2.cftunnel.com` failed from the Box but
succeeded externally, pointing to an outbound-network/SNI compatibility issue.
Linking/authorization alone does not verify a working tunnel.

T3 manages its relay client (`cloudflared` 2026.5.2) under
`/workspace/home/.t3/tools`; it is not a separate mise tool. To opt back into
T3 Connect after the network issue is resolved, link from interactive SSH:

```sh
mise exec -- t3 connect link --headless --base-dir /workspace/home/.t3
```

Approve installation of the managed relay client when prompted, then open the
device authorization URL in your browser and approve it. Restart T3 afterward
(or pause/resume the Box when no agent work is active) to provision the managed
connection. Check saved setup with:

```sh
mise exec -- t3 connect status --base-dir /workspace/home/.t3
```

This status describes persisted configuration, not a live tunnel probe.
Authorization is runtime state under the T3 data directory; it is not stored
in this repository or copied by bootstrap. Keep the same `--base-dir` for
Connect commands and the server.

### Direct public URL (browser access)

The original Upstash public URL remains available:

<https://certain-jaguar-48082-3773.preview.box.upstash.com/>

T3 protects the app with its own client pairing. To pair your browser, SSH into
the Box and create a fresh, short-lived link:

```sh
mise run ssh

# Run on the Box without relying on shell activation.
mise exec -- t3 auth pairing create \
  --base-dir /workspace/home/.t3 \
  --base-url https://certain-jaguar-48082-3773.preview.box.upstash.com \
  --ttl 5m --label my-browser
```

Open the generated pairing URL immediately. Treat it as a password; do not
commit it or share it. This nightly uses `t3 auth pairing create`, not the
older `t3 pair` command shown in the Upstash guide.

The running Box has a **Pi** provider configured, using the existing remote
OpenAI authentication. Both new-thread defaults and text generation (including
thread titles) use **Pi default**, which currently resolves to
`openai/gpt-6.1-sol` (the existing and shared dotfiles Pi settings agree).
Codex authentication is not required for titles with this configuration. On a fresh Box, add Pi in
**Settings → Providers**, then set the new-thread and text-generation models
in **Settings → General**, scoped to that Box. Provider settings are runtime
state; bootstrap does not overwrite them.

**Mobile:** use the beta app with the **Funnel URL**, not this Upstash preview
URL. The beta alone cannot fix the Upstash preview proxy, which does not
preserve the app's `Authorization: Bearer ...` header. With the same temporary
T3 bearer token, `/api/auth/session` reports `authenticated: true` locally and
`authenticated: false` through the public URL; requesting
`/api/auth/websocket-ticket` succeeds locally (200) but fails through the public
URL (401, `missing_credential`). Verified on 2026-10-07. This matches the open
[Upstash Authorization-header rewrite issue](https://github.com/upstash/box/issues/167).

Browser pairing uses a session cookie and works through this proxy. Native
mobile clients use bearer authentication and need a route that preserves it;
issuing more pairing links does not fix the transport. The verified Funnel
route above preserves bearer authentication and WebSocket upgrades without
requiring a VPN on your phone. Do not disable T3 authentication.

### Startup and persistence

The launcher serves on `0.0.0.0:3773` with `--base-dir /workspace/home/.t3`.
For this Box, the following Upstash **Init Command** is configured:

```sh
/home/boxuser/.local/bin/remote-agent-start
```

`scripts/box-start.sh` is installed by mise and starts both launchers detached,
with private logs. Tailscale restores the saved Funnel configuration. Do not
run the init command manually while T3 is already running on port 3773; the
Tailscale launcher is locked against duplicates, but T3 is not.
The init command is managed in Upstash, not by mise; a new Box needs its own
init command and Tailscale authorization. Use the Funnel URL for browser and
mobile pairing. T3 Connect remains disabled.

Projects, conversations, settings, browser pairing, and T3 Connect authorization
live under `/workspace/home/.t3`. Keep any separately selected project directory under
`/workspace` too. Logs are at `/workspace/home/.t3/server.log` and can contain
pairing credentials: inspect them privately, not in shared output.

The init command is registered for automatic startup when the Box resumes.
A full Box reset can remove installed tools; rerun bootstrap afterward.
Tailscale logs are at `/workspace/home/.tailscale/daemon.log`. Its persistent
identity and Funnel configuration live under `/workspace/home/.tailscale`;
keep this directory private and never copy it into the bootstrap repository.

### Updating the nightly

Resolve a newer nightly with `npm view t3 dist-tags.nightly`, update
`"npm:t3"` in **`remote-tools.toml` only**, then rerun
`mise run bootstrap-remote -- --yes`. Restart T3 afterward (or pause/resume
through Upstash once active work has finished). Installing a new pin does not
replace an already running process. The pin does not auto-update every night.

A native remote `--dry-run` previews outer provisioning only: it does not run
hooks or the task that applies shared dotfiles and enrolls the local identity.
It is not a complete shared-dotfiles preview or an MCP connectivity test.
Updating Pi packages can surface upstream npm audit findings; review those
separately rather than using `npm audit fix --force` during bootstrap.

## Validation and rollout status

Offline checks: `python -m unittest discover -s tests -v` covers the native config
contract, unique fresh identities, repeat provisioning, rejection of partial and
legacy fnox state, no-clobber signing exports and failed-export cleanup, and
transport argument forwarding without a local fnox lookup. Persistent-auth tests
use real fnox/age with synthetic credentials and an offline `op` stub: encryption,
fresh-process reuse, profile/default-environment isolation, stale-override
masking, read/write command forwarding, missing-token refusal, and non-interactive
cache refresh are covered. Actual 1Password sync, vault read/write and SSH signing
were subsequently validated live after enrollment (details below). Shell syntax
and TOML parsing are checked separately.

Live apply **completed on 2026-10-08 (Box UTC)**, without a remote dry-run or
GitHub credential relay. The public dotfiles checkout was clean at `ad5792b`:
this is the rollout observation, not a version pin; future applies track latest
published `main`.

Verified on the Linux-arm64 target:

- Official signed mise **2026.10.3**, shared bootstrap and remote tools installed.
  The remote-only `op` registry backend resolved 1Password CLI **2.40.0**;
  `aqua:1password/cli` could not resolve `latest` and is no longer used.
- Pi **1.0.4** packages updated; Tailscale **1.102.5** available through mise exec.
- Shared Git/Pi/fnox configuration applied, native `auto_env = true` deployed as a
  regular template file, and no Mac overlay or managed shell activation installed.
- Machine-local fnox config and fresh age identity are regular `0600` files in a
  `0700` directory, with the shared import and one matching local recipient.
  Legacy age override variables are absent from the runtime environment.
- Global hook directory is symlinked and protected at `0555`; audit found no
  overrides in two target repositories. On Linux, **50 hook tests passed** and
  the sibling remote-agent lifecycle fixture was skipped because that checkout
  is not installed there. All **51 hook tests** passed on the Mac, including the
  native mise updater fixture; all **6 remote migration tests** passed locally.
- A second full live apply converged without replacing the private identity and
  relocked the hook directory. T3 still returned HTTP **200** locally and the
  persistent Tailscale daemon socket remained present.

Conflicts were backed up, never force-overwritten. Initial legacy state remains
under `/home/boxuser/.local/state/remote-agent-migration/20261008-033736/`.
The temporarily restored old tool config and existing billion-context config
were moved aside into `20261008-064940-resume/` and
`20261008-065209-billion-context/` beneath that same migration directory; backup
directories are private. Only the verified managed Bash activation block was
removed. Services were not restarted and pause/resume remains untested.

The Pi extension npm audit reports **two high-severity findings**, in
`pi-web-access` and `@modelcontextprotocol/sdk`; its proposed fix requires a
major-version change. No `npm audit fix --force` was run. Review the upstream
package update separately from this migration.

Persistent-auth tasks were deployed in a further convergent live apply.
All **14 migration/auth tests** pass locally; all **8 persistent-auth tests** also
pass on the Linux Box with real fnox/age and a stub `op`. Missing enrollment is
correctly refused without falling back to external authentication.

After the owner supplied the token through the hidden prompt, live tests passed:

- The token is encrypted under `sync-age` in the isolated `op-auth` profile;
  private config/identity permissions remain correct.
- Fresh processes authenticated with no externally supplied token. Two unattended
  enrollment/refresh runs succeeded with stdin closed, retaining the exact age
  identity and existing signing key.
- A temporary nonsecret item was created in the real dev vault, read, edited and
  read back again, then deleted using normal recoverable 1Password deletion.
- The default secret environment resolved its encrypted cache with `op` disabled,
  without exposing the service-account token.
- A disposable Git repository produced and verified an SSH-signed commit from a
  fresh process without an SSH agent, injected token or interactive prompt.
- T3 health remained **200** and the persistent Tailscale socket remained present.

No service restart or reboot was performed. Signing after reboot/pause-resume and
private checkpoint authentication remain unvalidated. Do not copy credentials or
caches from migration backups into the source repository.
