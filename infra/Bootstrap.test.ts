import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Bootstrap, BootstrapController, MISE_VERSION, MISE_ARM64_SHA256, changedServices, inputsHash, sha256, bootstrapScript, providers, type BootstrapProps } from "./Bootstrap.ts";
import { BoxApi } from "./box-api.ts";

const root = "/workspace/home/.remote-agent";
const token = "offline-token-never-in-state-or-api";
const props: BootstrapProps = {
  boxId: "unit-box", commit: "a".repeat(40), dotfilesPin: "b".repeat(40),
  miseVersion: MISE_VERSION, miseSha256: MISE_ARM64_SHA256,
  tokenFingerprint: sha256(token), fingerprints: { t3: "t3-v1", tailscaled: "tailscale-v1", relay: "relay-v1", bao: "bao-v1" },
};
class FakeBootstrapBox {
  files = new Map<string, string>();
  commands: string[] = [];
  writes: string[] = [];
  launches = 0;
  encrypted = 0;
  locked = false;
  enrolled = true;
  launchStatus = "succeeded";
  progressReads = 0;
  calls: string[] = [];
  heads = [props.commit, props.dotfilesPin];
  install(hash: string, p = props) {
    this.heads = [p.commit, p.dotfilesPin];
    this.files.set(`${root}/current-installation.json`, JSON.stringify({ hash, remoteAgentHead: p.commit, dotfilesHead: p.dotfilesPin }));
  }
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.handle(request) });
  api = new BoxApi({ baseUrl: this.server.url.origin, apiKey: Redacted.make("offline-api-key") });
  controller() {
    return new BootstrapController(this.api, {
      sleep: async () => {}, token: () => Redacted.make(token),
      encrypt: async (_recipient, value) => { expect(value).toBe(token); this.encrypted++; return new TextEncoder().encode("age-ciphertext-only"); },
    });
  }
  reset() { this.heads = [props.commit, props.dotfilesPin]; this.files.clear(); this.commands = []; this.writes = []; this.calls = []; this.launches = this.encrypted = this.progressReads = 0; this.locked = false; this.enrolled = true; this.launchStatus = "succeeded"; }
  seed(p = props) {
    this.install(inputsHash(p), p);
    this.files.set(`${root}/bootstrap/${inputsHash(p)}/result.json`, JSON.stringify({ status: "succeeded", hash: inputsHash(p) }));
    this.files.set(`${root}/auth.json`, JSON.stringify({ tokenFingerprint: p.tokenFingerprint }));
    this.files.set(`${root}/applied.json`, JSON.stringify({ fingerprints: p.fingerprints }));
  }
  async handle(request: Request) {
    if (request.headers.get("Authorization") !== "Bearer offline-api-key") return new Response(null, { status: 401 });
    const body = await request.json();
    this.calls.push(JSON.stringify(body));
    if (new URL(request.url).pathname.endsWith("/files/write")) {
      this.files.set(body.path, Buffer.from(body.content, "base64").toString()); this.writes.push(body.path);
      return Response.json({});
    }
    expect(Array.isArray(body.command)).toBe(true);
    const command = body.command[2] as string;
    this.commands.push(command);
    let output = "";
    if (command.startsWith("if [ -f")) {
      const path = command.match(/-f '([^']+)'/)![1];
      const text = this.files.get(path);
      if (text?.includes('"status":"running"') && this.progressReads-- === 0) {
        const hash = path.split('/').at(-2)!;
        this.files.set(path, JSON.stringify({ status: "succeeded", hash }));
        this.install(hash);
      }
      output = this.files.get(path) ?? "null";
    } else if (command.includes("remote-agent-bao-status")) {
      // Box exec merges streams; mise may print warnings before the status line.
      output = `mise WARN  fixture warning\n${JSON.stringify({ enrolled: this.enrolled })}\n`;
    }
    else if (command.includes("cat --")) {
      const paths = [...command.slice(command.indexOf("cat --")).matchAll(/'([^']+)'/g)].map(m => m[1]);
      const dest = command.match(/mv -- '[^']+' '([^']+)'/)![1];
      const parts = paths.filter(path => /\.alchemy-[^.]+\.\d+$/.test(path));
      this.files.set(dest, parts.map(path => this.files.get(path) ?? "").join(""));
    } else if (command.includes("printf free")) output = this.locked ? "locked" : "free";
    else if (command.includes("setsid nohup sh")) {
      this.launches++;
      this.files.delete(`${root}/current-installation.json`);
      const path = command.match(/nohup sh '([^']+)'/)![1].replace(/run.sh$/, "result.json");
      const hash = path.split('/').at(-2)!;
      this.files.set(path, JSON.stringify({ status: this.launchStatus, hash }));
      if (this.launchStatus === "succeeded") {
        const script = this.files.get(path.replace(/result.json$/, 'run.sh'))!;
        const pins = [...script.matchAll(/checkout "\$HOME\/(?:remote-agent|dotfiles)" https:\/\/github.com\/sweepies\/[^ ]+ '([a-f0-9]{40})'/g)].map(m => m[1]!);
        this.install(hash, { ...props, commit: pins[0]!, dotfilesPin: pins[1]! });
      }
    } else if (command.startsWith('git -C "$HOME/remote-agent" rev-parse HEAD')) output = this.heads.join('\n') + '\n';
    else if (command.startsWith("tail -n")) throw new Error("Private bootstrap output must never be requested");
    else if (command.includes("age-keygen -y")) output = "age1" + "x".repeat(58);
    else if (command.includes("REQUEST=")) {
      const request = JSON.parse(command.match(/REQUEST='([^']+)'/)![1]);
      this.files.set(`${root}/restarts/${request.hash}.json`, JSON.stringify({ ...request, baseline: {} }));
    } else if (command.startsWith("rm -f") && !command.includes(".alchemy-")) {
      for (const match of command.matchAll(/'([^']+)'/g)) this.files.delete(match[1]);
    }
    return Response.json({ exit_code: 0, output });
  }
}
const fake = new FakeBootstrapBox();
afterAll(() => fake.server.stop(true));
beforeEach(() => fake.reset());
const { test: providerTest } = Test.make({ providers: providers(fake.controller()), stage: "bootstrap-offline", dev: false, sidecar: false });

providerTest.provider("Bootstrap resource idempotence with encrypted credential delivery", stack => Effect.gen(function* () {
  const { tokenFingerprint: _fingerprint, ...input } = props;
  const program = Bootstrap("bootstrap", { ...input, opToken: Redacted.make(token) });
  const first = yield* stack.deploy(program);
  expect(first.restart).toBe("pending");
  const second = yield* stack.deploy(program);
  expect(second.hash).toBe(first.hash);
  expect(fake.launches).toBe(1);
  expect(fake.encrypted).toBe(1);
  expect(JSON.stringify(second)).not.toContain(token);
  expect(fake.calls.join("\n")).not.toContain(token);
  yield* stack.destroy();
}));

test("read after a create that never got a Box ID observes nothing", async () => {
  fake.reset();
  expect(await fake.controller().read({ ...props, boxId: "" })).toBeUndefined();
  expect(fake.commands).toHaveLength(0);
});
test("same succeeded inputs and matching token are a bootstrap no-op", async () => {
  fake.seed();
  const result = await fake.controller().reconcile(props);
  expect(result.restart).toBe("applied");
  expect(fake.launches).toBe(0); expect(fake.encrypted).toBe(0);
  expect(fake.writes).toHaveLength(0);
});
test("in progress waits without launching a second child", async () => {
  fake.seed(); fake.files.delete(`${root}/current-installation.json`); fake.locked = true; fake.progressReads = 2;
  fake.files.set(`${root}/bootstrap/${inputsHash(props)}/result.json`, '{"status":"running"}');
  await fake.controller().reconcile(props);
  expect(fake.launches).toBe(0);
});
test("stale running marker after pause resumes when lock is free", async () => {
  fake.seed(); fake.files.delete(`${root}/current-installation.json`); fake.progressReads = 5;
  fake.files.set(`${root}/bootstrap/${inputsHash(props)}/result.json`, '{"status":"running"}');
  await fake.controller().reconcile(props);
  expect(fake.launches).toBe(1);
});
test("failure names the private Box log and hash only; subsequent apply retries", async () => {
  fake.launchStatus = "failed";
  fake.files.set(`${root}/bootstrap/${inputsHash(props)}/log`, "fixture-sensitive-bootstrap-log");
  await expect(fake.controller().reconcile(props)).rejects.toThrow(`Bootstrap failed (hash ${inputsHash(props)}); inspect ${root}/bootstrap/${inputsHash(props)}/log privately on the Box`);
  expect(fake.commands.some(command => command.startsWith("tail -n"))).toBe(false);
  fake.launchStatus = "succeeded";
  await fake.controller().reconcile(props);
  expect(fake.launches).toBe(2);
});
test("in-progress polling deadline is bounded without forcing processes", async () => {
  fake.seed(); fake.files.delete(`${root}/current-installation.json`); fake.locked = true; fake.progressReads = 999;
  fake.files.set(`${root}/bootstrap/${inputsHash(props)}/result.json`, '{"status":"running"}');
  let clock = 0;
  const controller = new BootstrapController(fake.api, { now: () => clock, deadlineMs: 10, sleep: async () => { clock += 10; } });
  await expect(controller.reconcile(props)).rejects.toThrow("deadline exceeded");
  expect(fake.launches).toBe(0);
});
test("token fingerprint drift re-delivers ciphertext only, not bootstrap", async () => {
  fake.seed(); fake.files.set(`${root}/auth.json`, '{"tokenFingerprint":"old"}');
  await fake.controller().reconcile(props); await fake.controller().reconcile(props);
  expect(fake.encrypted).toBe(1); expect(fake.launches).toBe(0);
  expect(fake.calls.join("\n")).not.toContain(token);
  expect(fake.commands.some(command => command.includes("pipefail") && command.includes("--profile op-auth set OP_SERVICE_ACCOUNT_TOKEN"))).toBe(true);
  expect(fake.commands.some(command => command.includes("chmod 600") && command.includes("token-"))).toBe(true);
});
test("missing/mismatched markers report drift; pending/done/abandoned are observed", async () => {
  const controller = fake.controller();
  expect(await controller.read(props)).toBeUndefined(); fake.seed();
  expect((await controller.read(props))?.restart).toBe("applied");
  for (const status of ["pending", "done", "abandoned"] as const) {
    fake.files.set(`${root}/restarts/${inputsHash(props)}.json`, JSON.stringify({ status, hash: inputsHash(props), fingerprints: props.fingerprints }));
    expect((await controller.read(props))?.restart).toBe(status);
  }
  fake.files.set(`${root}/restarts/${inputsHash(props)}.json`, JSON.stringify({ status: "done", hash: "wrong", fingerprints: props.fingerprints }));
  expect(await controller.read(props)).toBeUndefined();
  fake.files.delete(`${root}/restarts/${inputsHash(props)}.json`);
  fake.files.set(`${root}/current-installation.json`, '{"hash":"wrong"}');
  expect(await controller.read(props)).toBeUndefined();
  fake.seed(); fake.files.delete(`${root}/auth.json`); expect(await controller.read(props)).toBeUndefined();
});
test("A → B → A reinstalls A despite its historical success record", async () => {
  const controller = fake.controller();
  const b = { ...props, commit: "c".repeat(40), dotfilesPin: "d".repeat(40), fingerprints: { ...props.fingerprints, t3: "t3-v2" } };
  await controller.reconcile(props);
  await controller.reconcile(b);
  expect(fake.heads).toEqual([b.commit, b.dotfilesPin]);
  expect(await controller.read(props)).toBeUndefined();
  await controller.reconcile(props);
  expect(fake.launches).toBe(3);
  expect(fake.heads).toEqual([props.commit, props.dotfilesPin]);
  expect(JSON.parse(fake.files.get(`${root}/current-installation.json`)!)).toEqual({ hash: inputsHash(props), remoteAgentHead: props.commit, dotfilesHead: props.dotfilesPin });
});
test("out-of-band HEAD drift invalidates current installation and reinstalls", async () => {
  fake.seed();
  fake.heads[0] = "e".repeat(40);
  const controller = fake.controller();
  expect(await controller.read(props)).toBeUndefined();
  await controller.reconcile(props);
  expect(fake.launches).toBe(1);
  expect(fake.heads).toEqual([props.commit, props.dotfilesPin]);
  expect((await controller.read(props))?.hash).toBe(inputsHash(props));
});
test("failed drift repair cannot retain the old current installation authority", async () => {
  fake.seed(); fake.heads[0] = "e".repeat(40); fake.launchStatus = "failed";
  const controller = fake.controller();
  await expect(controller.reconcile(props)).rejects.toThrow("Bootstrap failed (hash");
  fake.heads = [props.commit, props.dotfilesPin];
  expect(await controller.read(props)).toBeUndefined();
  expect(fake.files.has(`${root}/current-installation.json`)).toBe(false);
});
test("input classification: commit/dotfiles alone restart nothing; per-service drift is precise", () => {
  expect(changedServices(props.fingerprints, props.fingerprints)).toEqual([]);
  for (const name of ["t3", "tailscaled", "relay", "bao"] as const) expect(changedServices(props.fingerprints, { ...props.fingerprints, [name]: "changed" })).toEqual([name]);
  expect(inputsHash({ ...props, dotfilesPin: "c".repeat(40) })).not.toBe(inputsHash(props));
  expect(inputsHash({ ...props, tokenFingerprint: "d".repeat(64) })).toBe(inputsHash(props));
});
test("bootstrap script pins refs/checksum, refuses dirty repos and is credential-free", () => {
  const script = bootstrapScript(props, inputsHash(props));
  expect(script).toContain("sha256sum -c -"); expect(script).toContain("checkout --detach");
  expect(script).toContain("status --porcelain"); expect(script).toContain("flock 9");
  expect(script.indexOf('rm -f "$current"')).toBeLessThan(script.indexOf('checkout "$HOME/remote-agent"'));
  expect(script.indexOf('mv "$current.tmp" "$current"')).toBeGreaterThan(script.indexOf('"$mise" bootstrap --yes'));
  expect(script).toContain('"remoteAgentHead"'); expect(script).toContain('"dotfilesHead"');
  expect(script).not.toContain("curl|sh"); expect(script).not.toContain(token);
  expect(script).not.toContain("fetch origin main");
  const syntax = Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(script) });
  expect(syntax.exitCode).toBe(0);
});
test("unenrolled or stale Box fails reconcile after service launch without any Bao operation", async () => {
  fake.seed(); fake.enrolled = false;
  const controller = fake.controller();
  expect(await controller.read(props)).toBeUndefined();
  await expect(controller.reconcile(props)).rejects.toThrow("enroll required: run mise run agent:enroll");
  expect(fake.commands).toContain('"$HOME/.local/bin/remote-agent-start"');
  expect(fake.commands.join("\n")).not.toContain("openbao.example");
  expect(fake.commands.join("\n")).not.toContain("secret-id");
  expect(fake.encrypted).toBe(0);
});
test("missing status task and failed service init report enrollment rather than a generic exec error", async () => {
  fake.seed();
  const controller = new BootstrapController({
    write: (id, path, bytes) => fake.api.write(id, path, bytes),
    exec: (id, command) => {
      if (command.includes("remote-agent-bao-status") || command.includes('"$HOME/.local/bin/remote-agent-start"')) throw new Error("exec failed");
      return fake.api.exec(id, command);
    },
  });
  expect(await controller.read(props)).toBeUndefined();
  await expect(controller.reconcile(props)).rejects.toThrow("enroll required: run mise run agent:enroll");
});
test("service startup error never forwards arbitrary Box output to public CI", async () => {
  fake.seed();
  const controller = new BootstrapController({
    write: (id, path, bytes) => fake.api.write(id, path, bytes),
    exec: (id, command) => {
      if (command.includes('"$HOME/.local/bin/remote-agent-start"')) throw new Error("fixture-sensitive-Box-output");
      return fake.api.exec(id, command);
    },
  });
  await expect(controller.reconcile(props)).rejects.toThrow(`Service startup failed (hash ${inputsHash(props)}); inspect ${root}/services privately on the Box`);
});
test("host-side npm age encryption interoperates with the pinned on-box CLI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "remote-agent-age-test-"));
  try {
    const key = join(directory, "identity.txt");
    expect(Bun.spawnSync(["age-keygen", "-o", key]).exitCode).toBe(0);
    const recipient = Bun.spawnSync(["age-keygen", "-y", key]);
    const encrypter = new Encrypter(); encrypter.addRecipient(recipient.stdout.toString().trim());
    const ciphertext = await encrypter.encrypt(token);
    const decrypted = Bun.spawnSync(["age", "-d", "-i", key], { stdin: Buffer.from(ciphertext) });
    expect(decrypted.exitCode).toBe(0); expect(decrypted.stdout.toString()).toBe(token);
  } finally { rmSync(directory, { recursive: true }); }
});
