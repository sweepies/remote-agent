# Remote coding agent

One persistent Linux-arm64 Upstash Box runs T3 Code, a userspace Tailscale daemon,
an HTTP/WebSocket relay, and an OpenBao token agent. An Alchemy v2 stack manages the Box, API-only
bootstrap, authenticated preview and Cloudflare gateway:

**<https://agent.ops.sweepy.dev>** → Worker → authenticated Upstash preview on
3774 → in-box relay → T3 on **127.0.0.1:3773**.

The gateway preserves T3 bearer authentication despite Upstash replacing the
`Authorization` header. T3 pairing/authentication remains enabled. The preview
credential authenticates the transport, not the user. There is no runtime
Upstash discovery, Upstash API key or enrollment token in the Worker.

## Deployment

Tools are pinned in `mise.toml`; JavaScript dependencies and their lockfile use
Bun. Alchemy is pinned to `2.0.0-beta.81`, Effect/platform packages to
`4.0.2`, using Alchemy's stable Effect 4 dependency graph. Live
Alchemy/Cloudflare qualification is still required. Install and validate locally
without cloud access:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run check
mise run test
```

`check` is a **plan-free static check**, not a cloud qualification. `plan` and
`deploy` require provisioned deployment credentials and may contact providers:

```sh
mise run plan
mise run deploy
```

Local construction refuses a dirty repository and deploys the exact `HEAD`.
In CI the pin is `GITHUB_SHA`. These checks prevent deploying files the Box
cannot fetch from the public repository. Do not deploy an unpublished commit.

### First deployment: adopt the existing Box

Discovery uses the exact label `remote-agent`; persisted ownership also requires
that the observed Box ID matches state. A moved/missing label fails closed on
normal updates: ownership recovery requires explicit adoption, not automatic
mutation or recreation. Existing
Box `certain-jaguar-48082` must have that label and empty `env_vars`. Check for
conflicting/missing labels and persisted environment variables privately before
adoption; metadata can contain plaintext secrets. API 0.7.9 has no documented
per-box environment-clear operation. Clear persisted values and any account
creation defaults through Upstash's supported administration flow before apply.
The provider fails rather than claiming successful secret removal.

With credentials supplied privately, the first deployment is:

```sh
mise exec -- bun run deploy --adopt
```

Alchemy's `read` reports a live labelled Box without matching state as `Unowned`;
`--adopt` grants ownership before reconcile mutates it. Two matching IDs are an
error, never an arbitrary choice. With no matching Box, create attaches the label
atomically. An uncertain create response is followed only by bounded observation,
not a second POST. If observation never resolves, **inspect the label before
starting another deployment process**: Upstash offers no create idempotency key
or uniqueness guarantee across processes.

A missing resource is re-observed, not assumed to exist from cached output.
If state still carries a Box ID, its absence never authorizes creation.
Size/runtime changes refuse replacement by default because replacement destroys
the filesystem. Destruction requires explicit `destroyOnDelete` consent already
persisted in a provider tombstone; replacement additionally requires
`allowReplace`. Normal stack deletion retains the Box, but deletes its preview
and gateway. Do not enable destructive flags casually.

On the existing Box, old unrecorded services are not killed by pattern matching.
Before the initial service migration, use the owner's live qualification to
verify idle state and safely stop/pause the legacy processes. A fresh resume
then creates tracked service groups. Bootstrap refuses modified remote-agent or
dotfiles checkouts; reconcile conflicts deliberately rather than resetting them.

### CI identity

`.github/workflows/deploy.yml` runs on pushes to `main` and manual dispatch, with
concurrency group `deploy` and **no cancellation**. It invokes
`sweepies/ops-workflows/.github/workflows/alchemy-deploy.yml`, pinned by commit
because deploys run code on a Box holding an OpenBao admin identity (push access
here, to dotfiles and to ops-workflows is admin-equivalent). Bumping the pin also
updates the OpenBao role `remote-agent-deploy`'s bound `job_workflow_ref` to the
same commit. The repository requires the Actions secret `BAO_ADDRESS` (already
provisioned), inherited by the shared workflow to supply the private OpenBao
address. Bootstrap and offline CI checks never need that address.
The shared workflow requests its own GitHub OIDC token; nothing is passed between jobs or stored as an
artifact. This repository's OIDC subject template is `repo` + `job_workflow_ref`
(immutable). The job logs in to OpenBao's GitHub JWT mount (`jwt/`) with role
`remote-agent-deploy`, bound to this repository's ID, `deploy.yml` on `main` and
the shared workflow:

- `deployment_profile: bun`
- `bao_jwt_role: remote-agent-deploy`
- `bao_secret_path: kv/remote-agent-deploy`
- `cloudflare_role: remote-agent-deploy`

`kv/remote-agent-deploy` supplies the Upstash key, OP service-account token and
Cloudflare account ID. The Cloudflare token is minted per run by OpenBao's
`cloudflare/` role `remote-agent-deploy` (account-owned; Workers, Secrets Store
read and `sweepy.dev` zone, DNS and Workers routes only) and deleted at
Cloudflare when the job revokes its OpenBao token. Never add those values to Git, Box environment
variables or workflow logs. Alchemy state uses `Cloudflare.state()`; protect
access to it because it necessarily retains the preview transport token.

## Exact bootstrap and dotfiles pins

`dotfiles.lock` is one 40-hex commit and newline. The provider installs official
**mise v2026.10.4** from the Linux-arm64 binary release, verifies its pinned
SHA-256, and installs it as `~/.local/bin/mise`; there is no `curl | sh`.
It clones/fetches both public repositories and checks out the exact requested
commits, refusing dirty trees. It verifies the fetched `dotfiles.lock` agrees
with the requested dotfiles commit before running bootstrap.

Native mise `bootstrap.repos` update is deliberately absent: it could follow a
branch during shared bootstrap. The provider owns ref selection; the native
bootstrap hooks/files/tasks still apply shared configuration and install remote
launchers. The task verifies the existing dotfiles checkout against the lock and
scopes a writable Git-hook-directory window with cleanup on failure. No forced
reset, local snapshot copying, SSH bootstrap, SSH password tooling or legacy
interactive 1Password enrollment task remains.

Bootstrap is detached under a lifetime `flock`, with private log and atomic
`result.json` at:

`/workspace/home/.remote-agent/bootstrap/<inputs-hash>/`

Per-hash results are audit records, not installation authority. The sole current
record is `/workspace/home/.remote-agent/current-installation.json`, atomically
written only after successful bootstrap with the input hash and actual HEADs of
both repositories. It is invalidated before changing checkouts. A skip requires
this record to match the requested inputs and the live HEADs; A → B → A and
out-of-band checkout drift therefore reinstall rather than using old success.

The provider polls to a bounded 30-minute deadline. Current identical inputs
are a no-op; an active run is awaited, while a stale running marker after pause
can be resumed when its lock is free. Failure reports only a tail of the public
installation log. Enrollment runs separately with its output suppressed so the
bootstrap log does not contain vault results. Missing/mismatched markers report
drift and trigger reapplication, including after a rebuild.

### Automatic dotfiles updates

The companion workflow in `sweepies/dotfiles`, exactly
`.github/workflows/dispatch-remote-agent.yml` on `main`, logs in to OpenBao's
GitHub JWT mount (role `dotfiles-dispatch`) and mints a narrowly scoped
`sweepies-ops` installation token. It updates this repository's `dotfiles.lock`
on `main` only when the SHA differs, with `chore: bump dotfiles to <short sha>`,
then revokes its OpenBao token, which revokes the installation token. Every
token is masked. The App-authored commit triggers the normal deploy workflow;
no repository dispatch is required. Dotfiles updates never fetch-and-follow
`main` on the Box.

### GitHub login

Shared Git defaults live at `~/.config/git/config`. Git reads the regular,
machine-local `~/.gitconfig` afterward, so local settings win and
`git config --global` / `gh auth setup-git` leave the dotfiles checkout clean.
Dotfiles creates this local file when missing and migrates the known old symlink.
Sign in on each Box after bootstrap:

```sh
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git --hostname github.com
gh auth status --hostname github.com
```

Native GitHub CLI auth stays on the same Box across pause/resume; a fresh
replacement needs login again. Without a credential store, `gh` may save auth
in a local plaintext file. Keep that state out of dotfiles and deployment inputs.

## Secrets and machine identity

Shared fnox references come from `~/dotfiles/.config/fnox/shared.toml`. Each fresh
Box generates its own age identity and regular fnox config, both `0600` inside a
`0700` directory. Existing valid identity/config are retained; partial, symlinked
or legacy state fails with an actionable reconciliation message. Mac Secure
Enclave identities, old shared age keys, caches and Pi authentication are not
transported.

After bootstrap, the provider reads **only the public age recipient**, encrypts
the deployment token host-side with pinned `age-encryption`, uploads ciphertext,
and decrypts it directly into `fnox ... --profile op-auth set
OP_SERVICE_ACCOUNT_TOKEN --provider sync-age --global`. The private ciphertext
is removed on completion/failure. The command contains neither token plaintext
nor a Box environment secret. `remote-agent-enroll` then refreshes cached secrets
and provisions the signing key using the existing isolated vault task.

Alchemy beta81 serializes the contents of `Redacted` props. Therefore the
Bootstrap constructor strips its Redacted token **before registration**: only a
SHA-256 fingerprint enters props, outputs or state. The token is retained in
process memory for delivery, and redelivered only if the fingerprint changes or
the Box's auth marker is missing. Preview tokens are intentionally Redacted
outputs and Cloudflare secret bindings; they must be persisted to avoid rotating
on every deployment. An existing preview without a usable saved token fails
closed; it never implicitly rotates. For explicit recovery/rotation, change
`PREVIEW_ROTATION` in `alchemy.run.ts` to a new nonce (passed as the
`Upstash.BoxPreview.rotate` prop). The same deploy deletes the existing preview,
observes the port missing, then recreates it and updates the Worker binding with
the newly returned token. Keep the nonce unchanged afterward. This interrupts
the preview briefly; do not use rotation as routine drift recovery.

A 1Password service account needs the intended vault read/write permissions;
enrollment does not grant them. The local `op-auth` profile is not injected into
normal Pi/T3 environments. For deliberate vault operations on the Box:

```sh
~/.local/bin/mise run remote-agent-vault -- op item list --vault dev
~/.local/bin/mise run remote-agent-enroll
```

Supply sensitive item JSON through stdin, not command arguments. Refreshes use
the saved encrypted credential. Existing regular signing keys are not clobbered.
Register the exported public key as a GitHub **signing** key; private repository
and checkpoint authorization remain separate. Any same-user process can access
the age identity and persistent signing key: profile isolation is not a sandbox.

## OpenBao agent identity

The Box is **admin-equivalent** in OpenBao. Its address is private runtime
configuration supplied by the operator, never a repository default. All URLs
below use the placeholder `https://openbao.example`, not a live endpoint.
Its AppRole is `agent-remote-agent` on the existing `approle/` mount with policy
`admin`: service tokens have a 1-hour TTL and 24-hour maximum lifetime;
secret IDs have a 30-day TTL, unlimited uses, and are required for login.
OpenBao/`bao` is pinned to **2.7.1** on both machines.

Enrollment is a **human-only step**, separate from deployment. CI must never
receive permission to issue these AppRole credentials. Bootstrap only checks
local enrollment files and age; it does not contact OpenBao or issue credentials.
A first deployment (or a rebuilt/stale Box) starts the other services but fails
reconcile with **`enroll required: run mise run agent:enroll`**. The unenrolled
`bao` service refuses to start. Once bootstrap has installed the tools/tasks,
on the operator's Mac, with the existing Upstash key and `BAO_ADDR` supplied
from their **private environment**. The owner keeps `BAO_ADDR` in a private
repository's mise `[env]`; invoke enrollment with that environment active.
The address must be an absolute HTTPS origin with no path, query, fragment or
credentials. There is no fallback if it is absent or invalid. For example,
substituting the real address privately (never in this repository):

```sh
BAO_ADDR=https://openbao.example mise exec -- bao login -method=oidc
BAO_ADDR=https://openbao.example mise run agent:enroll
```

The task uses the human's default `bao` token helper, preserves `BAO_ADDR` for
the CLI and clears `BAO_TOKEN`/`VAULT_TOKEN` overrides. It idempotently writes the
AppRole settings, discovers exactly one Box using the same `remote-agent` label
as the provider, reads the public age
recipient and role ID, and issues a **five-minute response-wrapped** secret ID.
The address, wrapping token, public role ID and wrapping issue time leave the
Mac only age-encrypted through the existing BoxApi upload channel. The actual
secret ID is unwrapped only on the Box. The random private upload is removed even on
failure. An already-used/expired wrapper fails non-zero with a possible
interception warning; investigate an unexpected failure before re-enrolling.

The Box validates the payload address, verifies an AppRole login, durably
installs the files, retires prior accessors, then revokes the verification token.
Address (`address`), role ID, secret ID, metadata and generated agent config are
regular `0600` files in `/workspace/home/.remote-agent/bao/` (`0700`). A private
enrollment journal rolls forward interrupted installation; status remains
unenrolled until installation completes. Metadata contains only the accessor
and issue time, not credentials. Enrollment starts an absent `bao` service;
it does not interrupt T3 or an already-running token agent. The
local task prints only the role, accessor and expiry. After enrollment, retry the
normal deployment to complete reconcile.

`bao agent` renews its token and reauthenticates using those files. Its private
file sink is **`~/.vault-token` (`0600`)**, so T3, Pi and Claude can just run
`bao`. Enrollment/config atomically writes a private `0600` machine-local
`~/.config/mise/conf.d/remote-agent-bao.toml` containing only `[env]` and
`BAO_ADDR`; this file is outside the checkout. The agent uses `vault.address`
from its generated config; every enrollment/rotation request uses the enrolled
address. No token goes in Alchemy props/state, Box environment inputs or
command arguments. Any same-user
process can read this identity; file permissions are not a sandbox.

**Hard cutover: re-enrollment is required for the currently enrolled Box.**
Its old identity has no `/workspace/home/.remote-agent/bao/address` file, so
Bootstrap reports **enroll required** after this change, even if its secret ID
is still fresh. Missing/invalid address state never falls back to a repository
value or environment override. Run `BAO_ADDR=… mise run agent:enroll` from the
operator's private environment, then retry normal deployment. Re-enrollment
also supplies the machine-local mise environment and generated agent config.

At service start and every 24 hours, the service invokes
`remote-agent-bao-rotate`. It does nothing below seven days; otherwise it uses
the current token to issue a new secret ID, atomically replaces the secret file,
updates metadata, then destroys the old ID by accessor. A private journal resumes
interrupted publication/destruction without issuing another ID. Failures log
non-secret status and retry next cycle. A failed issue retains the old identity;
a failed destroy retains the new one and retries destruction. No secrets are
printed by the enrollment or rotation implementation; service output stays in
`/workspace/home/.remote-agent/services/bao.log` with private permissions.

If rotation cannot succeed before the **30-day lapse**, or the Box is paused for
30 days, the expired secret ID cannot perform another login. Bootstrap and a
fresh service start refuse that stale identity. A human must run
`BAO_ADDR=… mise run agent:enroll` again from their private environment;
deployment cannot recover it automatically.
Clock synchronization between the operator and Box is required for freshness
checks. Already-issued service tokens can live up to their 24-hour maximum.

**Revocation is deleting the role**, from the operator's human session:

```sh
BAO_ADDR=https://openbao.example mise exec -- bao delete auth/approle/role/agent-remote-agent
```

This disables new AppRole logins/secret-ID issuance. Already-issued tokens may
survive until their expiry or explicit token revocation; investigate/revoke live
tokens separately when an immediate incident cutoff is required. Re-enrollment
recreates the role deliberately; do not run enrollment after revocation unless
restoring this machine's admin access is intended.

## Access and service lifecycle

Create a short-lived pairing link privately on the Box using the gateway URL:

```sh
mise exec -- t3 auth pairing create \
  --base-dir /workspace/home/.t3 \
  --base-url https://agent.ops.sweepy.dev --ttl 5m --label mobile
```

Treat pairing links as passwords. Pi OAuth/provider preferences are persistent
runtime state, not provisioned configuration; a fresh Box still needs its own
provider login and T3 settings. Interactive SSH is an optional manual debugging
path only, not a deployment dependency.

The Box init command safely does nothing before the launcher is installed:

```sh
[ ! -x /home/boxuser/.local/bin/remote-agent-start ] || exec /home/boxuser/.local/bin/remote-agent-start
```

Init starts T3, Tailscale, relay and the enrolled Bao agent under lifetime locks, recording PID, process
group and Linux `/proc` start time. Stops target only those recorded groups and
validate the recorded leader identity before signalling; there is no broad
`pkill`. After SIGTERM they wait for the entire group to disappear, escalate to
SIGKILL after a bounded grace, and confirm group death before relaunching.
A surviving group fails closed rather than launching over lock-holding children. Logs and
service markers are private. T3 state lives in `/workspace/home/.t3`; Tailscale
identity/socket/Funnel state remains in `/workspace/home/.tailscale`.

The existing userspace Tailscale Funnel remains an alternate route to
127.0.0.1:3773. Unlike an authenticated Upstash preview request, Funnel/T3
traffic **does not count as Box API activity**. After six hours of API inactivity
the Box auto-pauses and kills all processes. An authenticated gateway request
can wake it; unauthenticated preview requests cannot. The gateway retries 502
startup failures with bounded backoff, and only for safely replayable requests;
large bodies and non-idempotent operations are never automatically duplicated.
Cookies, query strings and WebSocket upgrades are preserved. T3 Connect remains
independent and is not re-enabled by this stack.

### Gated restarts

Fingerprints distinguish T3 launcher/version, Tailscale launcher/version,
relay code/launcher, and Bao launcher/version/config/rotation code. Common process-launcher or Node changes affect the services
that depend on them. Dotfiles-only or unrelated source changes restart nothing.
Installing tools or checking out a commit does not forcibly terminate an active
T3 turn.

A changed service queues a detached, single-instance `flock` waiter. It runs the
read-only busy SQL from `services/restart-gate.mjs` every 30 seconds and requires
**two consecutive idle observations** before stopping only changed service
groups. Any database/schema/query error is busy. After 24 hours it records
`abandoned`, never a forced restart. Deployment returns `restart: pending`
without waiting for user work. Reads expose `applied`, `pending`, `done` or
`abandoned`; markers are under `/workspace/home/.remote-agent/restarts/`.
Pause/resume creates fresh process identities and satisfies pending restarts.
Per-service completion is persisted in each request against its own baseline.
If another service fails to start, later iterations (and restarted waiters) retry
only unfinished services, without repeating successful restarts.

**The busy query is an internal schema contract pinned to T3
`0.0.46-nightly.20261007.2774` in `remote-tools.toml`. Re-verify it whenever that
pin changes. T3 SIGTERM does not wait for turns.** There is no supported atomic
busy-and-stop API; the gate is conservative observation, not a T3 transaction.

## Offline verification and live qualification

All provider, relay, gateway and lifecycle tests use fakes or loopback servers.
The Python suites use real pinned fnox/age with synthetic credentials and an
offline `op` stub. AppRole tests use synthetic credentials with fake BoxApi,
Bao CLI, age and OpenBao HTTP operations; no live enrollment occurs. Static
checks do not run `alchemy plan` or contact providers.

Before enabling the production flow, qualify on a throwaway Box: adoption and
Bearer API auth, empty-environment enforcement, exact ref bootstrap, checksum,
private token delivery/enrollment, restart gating against the pinned SQLite
schema, pause/resume markers, preview rotation, gateway pairing/session auth,
WebSocket upgrade and wake behavior. Also qualify human response-wrapped AppRole
enrollment, the OpenBao 2.7.1 agent config/token helper and reauthentication after
secret-ID rotation, 30-day lapse/re-enrollment and revocation, the OpenBao App-token workflow and
Cloudflare domain/state permissions. Offline tests cannot establish those live
contracts. No historical rollout claims in this document qualify the new stack.
