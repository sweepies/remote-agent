import { Resource } from "alchemy";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Encrypter } from "age-encryption";
import { BoxApi } from "./box-api.ts";
import { createHash } from "node:crypto";

export const MISE_VERSION = "2026.10.4";
// Official v2026.10.4 SHASUMS256.txt, uncompressed linux-arm64 binary.
export const MISE_ARM64_SHA256 = "9013ce1d7d9bbbf65254cda178562f5450c474a705907c18b77e6b678bb10041";
const ROOT = "/workspace/home/.remote-agent";
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Box exec returns one combined stream; mise may add warnings or task headers.
// Status commands print one JSON line last, so parse only that line.
export const lastJSON = (text: string) => JSON.parse(text.trim().split("\n").at(-1) ?? "");
export type ServiceFingerprints = { t3: string; tailscaled: string; relay: string; bao: string };
export interface BootstrapProps {
  boxId: string;
  commit: string;
  dotfilesPin: string;
  miseVersion: string;
  miseSha256: string;
  tokenFingerprint: string;
  fingerprints: ServiceFingerprints;
}
export interface BootstrapOutput {
  boxId: string;
  hash: string;
  tokenFingerprint: string;
  fingerprints: ServiceFingerprints;
  restart: "applied" | "pending" | "done" | "abandoned";
}
export type Bootstrap = Resource<"RemoteAgent.Bootstrap", BootstrapProps, BootstrapOutput>;
const BootstrapResource = Resource<Bootstrap>("RemoteAgent.Bootstrap");
const tokens = new Map<string, Redacted.Redacted<string>>();
// Alchemy beta81 serializes Redacted contents in props. Strip the secret before
// resource registration: only its fingerprint may enter state, even old props.
export function Bootstrap(id: string, { opToken, ...props }: { [K in Exclude<keyof BootstrapProps, "tokenFingerprint">]: Input<BootstrapProps[K]> } & { opToken: Redacted.Redacted<string> }) {
  const tokenFingerprint = sha256(Redacted.value(opToken));
  tokens.set(tokenFingerprint, opToken);
  return BootstrapResource(id, { ...props, tokenFingerprint });
}
export function inputsHash(props: BootstrapProps) {
  return sha256(JSON.stringify([props.commit, props.dotfilesPin, props.miseVersion, props.miseSha256, props.fingerprints]));
}
export function changedServices(previous: Partial<ServiceFingerprints> | undefined, next: ServiceFingerprints) {
  return (["t3", "tailscaled", "relay", "bao"] as const).filter(name => previous?.[name] !== next[name]);
}
export function validateInputs(props: BootstrapProps) {
  if (![props.commit, props.dotfilesPin].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error("Remote-agent and dotfiles pins must be 40-hex commits");
  if (props.miseVersion !== MISE_VERSION || props.miseSha256 !== MISE_ARM64_SHA256) throw new Error("Unsupported mise binary pin");
  if (!/^[a-f0-9]{64}$/.test(props.tokenFingerprint)) throw new Error("Token fingerprint must be SHA-256");
}

// Bootstrap code contains public pins only. No credential is placed in command arguments or files.
export function bootstrapScript(props: BootstrapProps, hash: string) {
  const directory = `${ROOT}/bootstrap/${hash}`;
  return `#!/bin/sh
set -eu
umask 077
exec 9>${quote(`${ROOT}/bootstrap.lock`)}
flock 9
current=${quote(`${ROOT}/current-installation.json`)}
if [ -f "$current" ] && grep -q '"hash":"${hash}"' "$current" &&
 grep -q '"remoteAgentHead":"${props.commit}"' "$current" && grep -q '"dotfilesHead":"${props.dotfilesPin}"' "$current" &&
 [ "$(git -C "$HOME/remote-agent" rev-parse HEAD 2>/dev/null || true)" = ${quote(props.commit)} ] &&
 [ "$(git -C "$HOME/dotfiles" rev-parse HEAD 2>/dev/null || true)" = ${quote(props.dotfilesPin)} ]; then exit 0; fi
# Invalidate before touching checkouts: restoring old HEADs is not a successful install.
rm -f "$current"
printf '%s\\n' '{"status":"running","hash":"${hash}"}' > ${quote(`${directory}/result.json`)}
hooks=''
relock() { if [ -n "$hooks" ] && [ -d "$hooks" ]; then chmod a-w "$hooks"; fi; }
finish() {
 code=$?
 relock
 if [ "$code" = 0 ]; then status=succeeded; else status=failed; fi
 printf '{"status":"%s","exitCode":%s,"hash":"${hash}"}\\n' "$status" "$code" > ${quote(`${directory}/result.json.tmp`)}
 mv ${quote(`${directory}/result.json.tmp`)} ${quote(`${directory}/result.json`)}
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$HOME/.local/bin"
mise="$HOME/.local/bin/mise"
if [ ! -x "$mise" ] || [ "$("$mise" --version | awk '{print $1}')" != ${quote(props.miseVersion)} ]; then
 curl --fail --location --silent --show-error https://github.com/jdx/mise/releases/download/v${props.miseVersion}/mise-v${props.miseVersion}-linux-arm64 -o "$mise.download"
 printf '%s  %s\\n' ${quote(props.miseSha256)} "$mise.download" | sha256sum -c -
 chmod 755 "$mise.download"
 mv "$mise.download" "$mise"
fi
checkout() {
 path=$1 url=$2 pin=$3
 if [ ! -d "$path" ]; then git -c core.hooksPath=/dev/null clone "$url" "$path"; fi
 [ -d "$path/.git" ] && [ ! -L "$path" ] || { echo 'Refusing non-repository checkout'; exit 1; }
 [ -z "$(git -C "$path" status --porcelain)" ] || { echo 'Refusing modified checkout'; exit 1; }
 hooks="$path/.config/git/hooks"
 if [ -d "$hooks" ]; then chmod u+w "$hooks"; fi
 git -C "$path" -c core.hooksPath=/dev/null fetch "$url" "$pin"
 git -C "$path" -c core.hooksPath=/dev/null checkout --detach "$pin"
 [ "$(git -C "$path" rev-parse HEAD)" = "$pin" ]
 relock
 hooks=''
}
checkout "$HOME/remote-agent" https://github.com/sweepies/remote-agent ${quote(props.commit)}
checkout "$HOME/dotfiles" https://github.com/sweepies/dotfiles ${quote(props.dotfilesPin)}
cd "$HOME/remote-agent"
[ "$(tr -d '\\n' < dotfiles.lock)" = ${quote(props.dotfilesPin)} ] || { echo 'Checked-out dotfiles.lock differs from requested pin'; exit 1; }
"$mise" trust mise.toml
"$mise" bootstrap --yes
remote_head=$(git -C "$HOME/remote-agent" rev-parse HEAD)
dotfiles_head=$(git -C "$HOME/dotfiles" rev-parse HEAD)
[ "$remote_head" = ${quote(props.commit)} ] && [ "$dotfiles_head" = ${quote(props.dotfilesPin)} ] || { echo 'Checkout HEAD drifted during bootstrap'; exit 1; }
printf '{"hash":"${hash}","remoteAgentHead":"%s","dotfilesHead":"%s"}\\n' "$remote_head" "$dotfiles_head" > "$current.tmp"
mv "$current.tmp" "$current"
`;
}

interface Marker { status?: string; tokenFingerprint?: string; hash?: string; fingerprints?: ServiceFingerprints; remoteAgentHead?: string; dotfilesHead?: string }
export interface BootstrapApi {
  exec(boxId: string, command: string): Promise<string>;
  write(boxId: string, path: string, bytes: Uint8Array): Promise<void>;
}
export class BootstrapController {
  constructor(readonly api: BootstrapApi, readonly options: {
    sleep?: (ms: number) => Promise<void>; now?: () => number; deadlineMs?: number;
    encrypt?: (recipient: string, token: string) => Promise<Uint8Array>;
    token?: (fingerprint: string) => Redacted.Redacted<string>;
  } = {}) {}
  private async marker(boxId: string, path: string): Promise<Marker | undefined> {
    const text = await this.api.exec(boxId, `if [ -f ${quote(path)} ]; then cat ${quote(path)}; else printf null; fi`);
    try { return JSON.parse(text) ?? undefined; } catch { return undefined; }
  }
  private async installed(props: BootstrapProps): Promise<boolean> {
    const current = await this.marker(props.boxId, `${ROOT}/current-installation.json`);
    if (current?.hash !== inputsHash(props) || current.remoteAgentHead !== props.commit || current.dotfilesHead !== props.dotfilesPin) return false;
    const heads = await this.api.exec(props.boxId, `git -C "$HOME/remote-agent" rev-parse HEAD 2>/dev/null || true; git -C "$HOME/dotfiles" rev-parse HEAD 2>/dev/null || true`);
    return heads.trim() === `${current.remoteAgentHead}\n${current.dotfilesHead}`;
  }
  private async enrolled(boxId: string): Promise<boolean> {
    try {
      const text = await this.api.exec(boxId, 'cd "$HOME"; "$HOME/.local/bin/mise" run --quiet remote-agent-bao-status');
      return lastJSON(text)?.enrolled === true;
    } catch { return false; }
  }
  async read(props: BootstrapProps): Promise<BootstrapOutput | undefined> {
    // A create that failed before its Box existed persists no Box ID; nothing to observe.
    if (!props.boxId) return undefined;
    const hash = inputsHash(props);
    const installed = await this.installed(props);
    const auth = await this.marker(props.boxId, `${ROOT}/auth.json`);
    const tokenFingerprint = props.tokenFingerprint;
    if (!installed || auth?.tokenFingerprint !== tokenFingerprint || !(await this.enrolled(props.boxId))) return undefined;
    const restart = await this.marker(props.boxId, `${ROOT}/restarts/${hash}.json`);
    const applied = await this.marker(props.boxId, `${ROOT}/applied.json`);
    if (restart && (restart.hash !== hash || JSON.stringify(restart.fingerprints) !== JSON.stringify(props.fingerprints))) return undefined;
    if ((!restart || restart.status === "done") && changedServices(applied?.fingerprints, props.fingerprints).length) return undefined;
    const status = restart?.status ?? "applied";
    if (!["applied", "pending", "done", "abandoned"].includes(status)) return undefined;
    return { boxId: props.boxId, hash, tokenFingerprint, fingerprints: props.fingerprints, restart: status as BootstrapOutput["restart"] };
  }
  async reconcile(props: BootstrapProps): Promise<BootstrapOutput> {
    validateInputs(props);
    const hash = inputsHash(props);
    const directory = `${ROOT}/bootstrap/${hash}`;
    await this.api.exec(props.boxId, `umask 077; mkdir -p ${quote(directory)} ${quote(`${ROOT}/restarts`)}; chmod 700 ${quote(ROOT)} ${quote(directory)}`);
    let result = await this.marker(props.boxId, `${directory}/result.json`);
    if (!(await this.installed(props))) {
      const locked = await this.api.exec(props.boxId, `if flock -n ${quote(`${ROOT}/bootstrap.lock`)} true; then printf free; else printf locked; fi`);
      if (result?.status !== "running" || locked.trim() === "free") {
        // Per-hash results are audit records only; the child replaces them when it starts.
        // Remove an old failure so it cannot terminate polling before the new child runs.
        if (result?.status === "failed") await this.api.exec(props.boxId, `rm -f ${quote(`${directory}/result.json`)}`);
        await this.api.write(props.boxId, `${directory}/run.sh`, new TextEncoder().encode(bootstrapScript(props, hash)));
        // The lifetime lock also serializes different input hashes. A stale
        // running marker after pause is resumable because the lock is free.
        await this.api.exec(props.boxId, `umask 077; setsid nohup sh ${quote(`${directory}/run.sh`)} >>${quote(`${directory}/log`)} 2>&1 </dev/null &`);
      }
      const now = this.options.now ?? Date.now;
      const deadline = now() + (this.options.deadlineMs ?? 30 * 60 * 1000);
      do {
        result = await this.marker(props.boxId, `${directory}/result.json`);
        if (await this.installed(props)) break;
        if (result?.status === "failed") {
          throw new Error(`Bootstrap failed (hash ${hash}); inspect ${directory}/log privately on the Box`);
        }
        if (now() >= deadline) throw new Error(`Bootstrap deadline exceeded; inspect ${directory}/log on the Box`);
        await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
      } while (true);
    }
    const tokenFingerprint = props.tokenFingerprint;
    const auth = await this.marker(props.boxId, `${ROOT}/auth.json`);
    if (auth?.tokenFingerprint !== tokenFingerprint) {
      const recipient = (await this.api.exec(props.boxId, `cd "$HOME"; "$HOME/.local/bin/mise" exec -- age-keygen -y "$HOME/.config/fnox/age.txt"`)).trim();
      if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error("Box returned an invalid age recipient");
      const encrypt = this.options.encrypt ?? (async (recipient, token) => {
        const encrypter = new Encrypter(); encrypter.addRecipient(recipient);
        return encrypter.encrypt(token);
      });
      const token = this.options.token?.(tokenFingerprint) ?? tokens.get(tokenFingerprint) ?? Redacted.make(Bun.env.OP_SERVICE_ACCOUNT_TOKEN ?? "");
      if (!Redacted.value(token) || sha256(Redacted.value(token)) !== tokenFingerprint) throw new Error("Required enrollment token does not match the requested fingerprint");
      const ciphertext = await encrypt(recipient, Redacted.value(token));
      const path = `${ROOT}/token-${crypto.randomUUID()}.age`;
      await this.api.exec(props.boxId, "umask 077; :");
      await this.api.write(props.boxId, path, ciphertext);
      // bash pipefail prevents a failed decryption from storing an empty credential.
      // Output is intentionally discarded; enrollment output can include secret data.
      await this.api.exec(props.boxId, `bash -c ${quote(`set -euo pipefail; set +x; umask 077; cd "$HOME"; unset FNOX_AGE_KEY FNOX_AGE_KEY_FILE REMOTE_AGE_KEY OP_SERVICE_ACCOUNT_TOKEN FNOX_OP_SERVICE_ACCOUNT_TOKEN FNOX_PROFILE; trap 'rm -f ${quote(path)}' EXIT; chmod 600 ${quote(path)}; "$HOME/.local/bin/mise" exec -- age -d -i "$HOME/.config/fnox/age.txt" ${quote(path)} | "$HOME/.local/bin/mise" exec -- fnox --config "$HOME/.config/fnox/config.toml" --no-daemon --profile op-auth set OP_SERVICE_ACCOUNT_TOKEN --provider sync-age --global; chmod 600 "$HOME/.config/fnox/config.toml"; "$HOME/.local/bin/mise" run remote-agent-enroll`)} >/dev/null 2>&1`);
      await this.api.write(props.boxId, `${ROOT}/auth.json`, new TextEncoder().encode(JSON.stringify({ tokenFingerprint })));
    }
    const applied = await this.marker(props.boxId, `${ROOT}/applied.json`);
    const services = changedServices(applied?.fingerprints, props.fingerprints);
    const existing = await this.marker(props.boxId, `${ROOT}/restarts/${hash}.json`);
    if (services.length && (!existing || existing.status === "done" || existing.hash !== hash || JSON.stringify(existing.fingerprints) !== JSON.stringify(props.fingerprints))) {
      const request = { hash, fingerprints: props.fingerprints, services, created: Date.now(), status: "pending" };
      await this.api.exec(props.boxId, `cd "$HOME"; REQUEST=${quote(JSON.stringify(request))} "$HOME/.local/bin/mise" exec -- node --input-type=module -e ${quote(`import {live,atomicJSON} from './remote-agent/services/processes.mjs'; const r=JSON.parse(process.env.REQUEST); r.baseline=Object.fromEntries(r.services.map(n=>[n,live(n)??null])); atomicJSON('${ROOT}/restarts/${hash}.json',r);`)}`);
    }
    // Start absent services immediately. Existing ones retain their lifetime locks.
    let startError: unknown;
    try { await this.api.exec(props.boxId, `"$HOME/.local/bin/remote-agent-start"`); }
    catch (error) { startError = error; }
    // A missing bao service can fail init. Report the actionable local identity
    // check after starting services, rather than the generic exec failure.
    if (!(await this.enrolled(props.boxId))) throw new Error("enroll required: run mise run agent:enroll on the operator machine");
    if (startError) throw new Error(`Service startup failed (hash ${hash}); inspect ${ROOT}/services privately on the Box`);
    await this.api.exec(props.boxId, `umask 077; setsid nohup flock -n ${quote(`${ROOT}/restart.lock`)} sh -c 'cd "$HOME/remote-agent"; exec "$HOME/.local/bin/mise" run remote-agent-restart' >>${quote(`${ROOT}/restart.log`)} 2>&1 </dev/null &`);
    return (await this.read(props)) ?? { boxId: props.boxId, hash, tokenFingerprint, fingerprints: props.fingerprints, restart: "pending" };
  }
}
export const bootstrapService = (controller: BootstrapController) => BootstrapResource.Provider.of({
  reconcile: ({ news }) => Effect.tryPromise(() => controller.reconcile(news)),
  read: ({ olds }) => Effect.tryPromise(() => controller.read(olds)),
  // Always observe markers on apply, including when props did not change.
  diff: () => Effect.succeed({ action: "update" } as const),
  delete: () => Effect.void,
  list: () => Effect.succeed([]),
});
export class Providers extends Provider.ProviderCollection<Providers>()("RemoteAgent") {}
export const providers = (controller = new BootstrapController(new BoxApi())) =>
  Layer.effect(Providers, Provider.collection([BootstrapResource])).pipe(Layer.provideMerge(Provider.succeed(BootstrapResource, bootstrapService(controller))));
