import { afterAll, beforeEach, expect, test as bunTest } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import * as Redacted from "effect/Redacted";
import { BoxApi, FILE_CHUNK_BYTES } from "./box-api";
import type { BoxAttributes, BoxProps, BoxPreviewAttributes } from "./Upstash";

import { Unowned } from "alchemy/AdoptPolicy";
import { Box, BoxPreview, providers, boxProviderService, previewProviderService } from "./Upstash";

interface FakeBox {
  id: string; name: string; labels: string[]; size: string; runtime: string; status: string;
  env_vars: Record<string, string>;
  network_policy: { mode: string; allowed_domains?: string[]; allowed_cidrs?: string[]; denied_cidrs?: string[] };
}
interface FakePreview { id: string; port: number; url: string; bearer_token: boolean; basic_auth: boolean }
interface Call { method: string; path: string; body: Record<string, unknown> }

// Real loopback HTTP exercises serialization and errors. The fake never forwards requests.
class FakeBoxServer {
  boxes: FakeBox[] = [];
  startup = new Map<string, string>();
  previews = new Map<string, FakePreview[]>();
  calls: Call[] = [];
  createResponseLost = false;
  createNeverVisible = false;
  hiddenLists = 0;
  execExit = 0;
  execOutput = "ok\n";
  execStdoutOnly = false;
  execMissingOutput = false;
  execFailAssembly = false;
  responseError = false;
  previewGenerations = 0;
  serial = 0;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
  get baseUrl() { return this.server.url.origin; }
  reset() {
    this.boxes = []; this.startup.clear(); this.previews.clear(); this.calls = [];
    this.createResponseLost = false; this.createNeverVisible = false; this.hiddenLists = 0;
    this.execExit = 0; this.execOutput = "ok\n"; this.execStdoutOnly = false; this.execMissingOutput = false;
    this.execFailAssembly = false; this.responseError = false; this.previewGenerations = 0; this.serial = 0;
  }
  seed(id = "box-1", label = "unit-label"): FakeBox {
    const box = { id, name: "unit", labels: [label], size: "small", runtime: "node", status: "idle", env_vars: {}, network_policy: { mode: "allow-all" } };
    this.boxes.push(box);
    return box;
  }
  count(method: string, path: string) { return this.calls.filter((c) => c.method === method && c.path === path).length; }
  async handle(request: Request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const body: Record<string, unknown> = request.body ? await request.json() : {};
    this.calls.push({ method, path, body });
    if (request.headers.get("Authorization") !== "Bearer offline-not-a-credential" || request.headers.has("X-Box-Api-Key")) return new Response("unauthorized", { status: 401 });
    if (this.responseError) return Response.json({ env_vars: { PRIVATE: "DO-NOT-LEAK" }, error: "DO-NOT-LEAK" }, { status: 500 });
    if (path === "/v2/box" && method === "GET") {
      if (this.hiddenLists > 0) { this.hiddenLists--; return Response.json([]); }
      const label = url.searchParams.get("label");
      return Response.json(this.boxes.filter((b) => !label || b.labels.includes(label)));
    }
    if (path === "/v2/box" && method === "POST") {
      const box = this.seed(`created-${++this.serial}`, (body.labels as string[])[0]);
      box.name = body.name as string; box.size = body.size as string; box.runtime = body.runtime as string;
      box.network_policy = body.network_policy as FakeBox["network_policy"];
      this.startup.set(box.id, body.init_command as string);
      if (this.createNeverVisible) this.boxes = this.boxes.filter((b) => b.id !== box.id);
      if (this.createResponseLost) { this.hiddenLists = 1; return Response.json({ error: "DO-NOT-LEAK" }, { status: 503 }); }
      return Response.json(box);
    }
    const segments = path.split("/").slice(3).map(decodeURIComponent);
    const id = segments[0];
    const box = this.boxes.find((b) => b.id === id);
    if (!box) return new Response(null, { status: 404 });
    if (segments.length === 1 && method === "GET") return Response.json(box);
    if (segments.length === 1 && method === "DELETE") { this.boxes = this.boxes.filter((b) => b.id !== id); return new Response(null, { status: 204 }); }
    if (segments[1] === "startup") {
      if (method === "GET") return Response.json({ init_command: this.startup.get(id) ?? "" });
      if (method === "PUT") this.startup.set(id, body.init_command as string);
      if (method === "DELETE") this.startup.delete(id);
      return new Response(null, { status: 204 });
    }
    if (segments[1] === "config" && segments[2] === "network-policy" && method === "PUT") {
      box.network_policy = body as FakeBox["network_policy"]; return new Response(null, { status: 204 });
    }
    if (segments[1] === "config" && segments[2] === "labels" && method === "DELETE") {
      box.labels = box.labels.filter((label) => label !== segments[3]); return new Response(null, { status: 204 });
    }
    if (segments[1] === "preview") {
      const list = this.previews.get(id) ?? [];
      if (method === "GET") return Response.json({ previews: list });
      if (method === "POST") {
        const port = body.port as number;
        const url = `https://offline.invalid/${id}/${port}`;
        this.previews.set(id, [...list.filter((p) => p.port !== port), { id: `preview-${port}`, port, url, bearer_token: body.bearer_token === true, basic_auth: body.basic_auth === true }]);
        return Response.json({ port, url, token: `offline-token-${++this.previewGenerations}` });
      }
      if (method === "DELETE") this.previews.set(id, list.filter((p) => p.port !== Number(segments[2])));
      return new Response(null, { status: 204 });
    }
    if (segments[1] === "exec" && method === "POST") return Response.json({
      exit_code: this.execFailAssembly && (body.command as string[])[2].startsWith("umask 077 && cat -- ") ? 7 : this.execExit,
      ...(this.execMissingOutput ? {} : this.execStdoutOnly ? { stdout: this.execOutput } : { output: this.execOutput, stdout: "not-preferred" }),
      error: "DO-NOT-LEAK",
    });
    if (segments[1] === "files" && segments[2] === "write" && method === "POST") return new Response(null, { status: 204 });
    return new Response(null, { status: 400 });
  }
}
const fake = new FakeBoxServer();
const options = { apiKey: Redacted.make("offline-not-a-credential"), baseUrl: fake.baseUrl, observeAttempts: 3, pollIntervalMs: 0 };
const { test } = Test.make({ providers: providers(options), stage: "offline", dev: false, sidecar: false });
beforeEach(() => fake.reset());
afterAll(() => fake.server.stop(true));
const props: BoxProps = { name: "unit", label: "unit-label" };
const metadata = { id: "unit", fqn: "offline/unit", instanceId: "offline-instance" };
const session = { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void };
const input = (news: BoxProps = props, output?: BoxAttributes) => ({ ...metadata, news, olds: undefined, output, session, bindings: [] });
const deletion = (olds: BoxProps, output: BoxAttributes) => ({ ...metadata, olds, output, session, bindings: [] });
const diffInput = (olds: BoxProps, news: BoxProps, output?: BoxAttributes) => ({ ...metadata, olds, news, output, oldBindings: [], newBindings: [] });
const outputFor = (id = "box-1"): BoxAttributes => ({ boxId: id, name: "unit", label: "unit-label", size: "small", runtime: "node", status: "idle" });
const run = Effect.runPromise;

// Alchemy's pinned Bun harness: actual plan/apply/read/state cycles, in-memory scratch state.
test.provider("offline Box identity creates atomically once and default delete preserves filesystem", (stack) => Effect.gen(function* () {
  const first = yield* stack.deploy(Box("unit", props));
  expect(first.boxId).toBe("created-1");
  expect(first.tombstone?.destroyOnDelete).toBe(false);
  yield* stack.deploy(Box("unit", { ...props, initCommand: "serve" }));
  expect(fake.count("POST", "/v2/box")).toBe(1);
  expect(fake.calls.find((c) => c.method === "POST" && c.path === "/v2/box")?.body.labels).toEqual([props.label]);
  expect(fake.startup.get(first.boxId)).toBe("serve");
  yield* stack.destroy();
  expect(fake.boxes).toHaveLength(1);
  expect(fake.count("DELETE", `/v2/box/${first.boxId}`)).toBe(0);
}));

test.provider("offline Box missing-state identity is not silently adopted", (stack) => Effect.gen(function* () {
  fake.seed();
  const result = yield* Effect.exit(stack.deploy(Box("unit", props)));
  expect(result._tag).toBe("Failure");
  expect(fake.count("POST", "/v2/box")).toBe(0);
  expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
}));

test.provider("offline Box deletion uses persisted destructive tombstone", (stack) => Effect.gen(function* () {
  const first = yield* stack.deploy(Box("unit", { ...props, destroyOnDelete: true }));
  expect(first.tombstone?.destroyOnDelete).toBe(true);
  yield* stack.destroy();
  expect(fake.boxes).toHaveLength(0);
  expect(fake.count("DELETE", `/v2/box/${first.boxId}`)).toBe(1);
}));

test.provider("offline Preview saved token survives redeploy and delete", (stack) => Effect.gen(function* () {
  const program = Effect.gen(function* () {
    const box = yield* Box("unit", { ...props, previewPorts: [3774] });
    const preview = yield* BoxPreview("preview", { boxId: box.boxId });
    return { box, preview };
  });
  const first = yield* stack.deploy(program);
  expect(Redacted.value(first.preview.token!)).toBe("offline-token-1");
  const second = yield* stack.deploy(program);
  expect(Redacted.value(second.preview.token!)).toBe("offline-token-1");
  expect(fake.previewGenerations).toBe(1);
  yield* stack.destroy();
  expect(fake.previews.get(first.box.boxId)).toEqual([]);
  expect(fake.boxes).toHaveLength(1);
}));

test.provider("explicit preview rotation updates its dependent binding in the same deploy", stack => Effect.gen(function* () {
  const program = (rotate: string) => Effect.gen(function* () {
    const box = yield* Box("unit", { ...props, previewPorts: [3774] });
    const preview = yield* BoxPreview("preview", { boxId: box.boxId, rotate });
    return { preview, workerBinding: Output.map(preview.token, value => value) };
  });
  const first = yield* stack.deploy(program(""));
  const second = yield* stack.deploy(program("rotation-1"));
  expect(Redacted.value(first.workerBinding!)).toBe("offline-token-1");
  expect(Redacted.value(second.workerBinding!)).toBe("offline-token-2");
  expect(second.preview.rotate).toBe("rotation-1");
  yield* stack.deploy(program("rotation-1"));
  expect(fake.previewGenerations).toBe(2);
  expect(fake.calls.filter(c => c.method === "DELETE" && c.path.endsWith("/preview/3774"))).toHaveLength(1);
  yield* stack.destroy();
}));

test.provider("offline immutable replacement is refused without opt-in", (stack) => Effect.gen(function* () {
  yield* stack.deploy(Box("unit", props));
  const result = yield* Effect.exit(stack.deploy(Box("unit", { ...props, size: "large" })));
  expect(result._tag).toBe("Failure");
  expect(fake.count("POST", "/v2/box")).toBe(1);
  expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  yield* stack.destroy();
}));

bunTest("zero/one/many label observations and cached IDs never bypass observation", async () => {
  const provider = boxProviderService(options);
  const first = await run(provider.reconcile(input()));
  expect(first.boxId).toBe("created-1");
  fake.calls = [];
  await expect(run(provider.reconcile(input({ ...props, initCommand: "serve" }, outputFor("stale-id"))))).rejects.toThrow("ownership recovery requires explicit adoption");
  expect(fake.calls.every(c => c.method === "GET")).toBe(true);
  expect((await run(provider.reconcile(input(props, first)))).boxId).toBe(first.boxId);
  expect(fake.count("POST", "/v2/box")).toBe(0);
  fake.seed("duplicate");
  await expect(run(provider.reconcile(input()))).rejects.toThrow("matching ids created-1, duplicate");
  expect(fake.count("POST", "/v2/box")).toBe(0);
});

bunTest("persisted Box absent fails closed without creation or mutation", async () => {
  await expect(run(boxProviderService(options).reconcile(input(props, outputFor())))).rejects.toThrow("persisted Box is absent");
  expect(fake.calls.every(c => c.method === "GET")).toBe(true);
});

test.provider("normal updates cannot mutate a different Box after label movement", stack => Effect.gen(function* () {
  const first = yield* stack.deploy(Box("unit", props));
  fake.boxes[0]!.labels = [];
  fake.seed("new-owner");
  fake.calls = [];
  const result = yield* Effect.exit(stack.deploy(Box("unit", { ...props, initCommand: "serve" })));
  expect(result._tag).toBe("Failure");
  expect(fake.calls.every(c => c.method === "GET")).toBe(true);
  expect(fake.startup.get(first.boxId)).toBe("");
}));

bunTest("read requires matching prior identity and reports disappeared objects", async () => {
  const provider = boxProviderService(options);
  fake.seed();
  const read = (output?: BoxAttributes) => run(provider.read!({ ...metadata, olds: props, output }));
  expect(Unowned.is(await read())).toBe(true);
  expect(Unowned.is(await read(outputFor("stale-id")))).toBe(true);
  expect(Unowned.is(await read(outputFor()))).toBe(false);
  fake.boxes = [];
  expect(await read(outputFor())).toBeUndefined();
});

bunTest("uncertain successful create is re-observed without another POST", async () => {
  fake.createResponseLost = true;
  const output = await run(boxProviderService(options).reconcile(input()));
  expect(output.boxId).toBe("created-1");
  expect(fake.count("POST", "/v2/box")).toBe(1);
});

bunTest("uncertain invisible create is bounded and same provider never re-POSTs", async () => {
  fake.createResponseLost = true; fake.createNeverVisible = true;
  const provider = boxProviderService(options);
  await expect(run(provider.reconcile(input()))).rejects.toThrow("no second POST");
  await expect(run(provider.reconcile(input()))).rejects.toThrow("no second POST");
  expect(fake.count("POST", "/v2/box")).toBe(1);
  expect(fake.count("GET", "/v2/box")).toBe(8);
});

bunTest("nonempty env_vars fails actionably before mutation without secret diagnostics", async () => {
  fake.seed().env_vars = { PRIVATE: "DO-NOT-LEAK" };
  try {
    await run(boxProviderService(options).reconcile(input({ ...props, initCommand: "serve" })));
    throw new Error("expected failure");
  } catch (error) {
    expect(String(error)).toContain("no documented per-box clear operation");
    expect(String(error)).not.toContain("DO-NOT-LEAK");
  }
  expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});

bunTest("startup, network policy, extra labels and unmanaged previews are synchronized", async () => {
  const box = fake.seed(); box.labels.push("extra");
  fake.startup.set(box.id, "stale");
  fake.previews.set(box.id, [
    { id: "managed", port: 3774, url: "https://offline.invalid/managed", bearer_token: true, basic_auth: false },
    { id: "unmanaged", port: 9999, url: "https://offline.invalid/unmanaged", bearer_token: false, basic_auth: false },
  ]);
  const provider = boxProviderService(options);
  await run(provider.reconcile(input({ ...props, initCommand: "serve", networkPolicy: { mode: "custom", allowedDomains: ["example.org"] }, previewPorts: [3774] })));
  expect(fake.startup.get(box.id)).toBe("serve");
  expect(box.labels).toEqual([props.label]);
  expect(box.network_policy).toEqual({ mode: "custom", allowed_domains: ["example.org"] });
  expect(fake.previews.get(box.id)?.map((p) => p.port)).toEqual([3774]);
  expect(fake.previewGenerations).toBe(0);
  await run(provider.reconcile(input()));
  expect(fake.startup.has(box.id)).toBe(false);
  expect(box.network_policy).toEqual({ mode: "allow-all" });
  expect(fake.previews.get(box.id)).toEqual([]);
});

bunTest("replacement requires two-step consent and a consistent provider tombstone", async () => {
  const provider = boxProviderService(options);
  const olds = { ...props, destroyOnDelete: true };
  const news = { ...olds, size: "large", allowReplace: true } as const;
  await expect(run(provider.diff!(diffInput(olds, news, outputFor())))).rejects.toThrow("tombstone");
  const output = await run(provider.reconcile(input(olds)));
  expect(await run(provider.diff!(diffInput(olds, news, output)))).toEqual({ action: "replace", deleteFirst: true });
  await expect(run(provider.diff!(diffInput(props, news, output)))).rejects.toThrow("deploy consent before replacing");
  await expect(run(provider.diff!(diffInput(olds, news, { ...output, tombstone: { ...output.tombstone!, boxId: "other" } })))).rejects.toThrow("inconsistent");
});

bunTest("delete defaults to no-op; destructive deletion refuses missing or stale consent and is idempotent", async () => {
  const provider = boxProviderService(options);
  fake.seed();
  await run(provider.delete(deletion(props, outputFor())));
  expect(fake.calls).toHaveLength(0);
  await expect(run(provider.delete(deletion({ ...props, destroyOnDelete: true }, outputFor())))).rejects.toThrow("tombstone");
  const output = await run(provider.reconcile(input({ ...props, destroyOnDelete: true })));
  fake.boxes[0].labels = [];
  await expect(run(provider.delete(deletion({ ...props, destroyOnDelete: true }, output)))).rejects.toThrow("label");
  fake.boxes[0].labels = [props.label];
  await run(provider.delete(deletion({ ...props, destroyOnDelete: true }, output)));
  await run(provider.delete(deletion({ ...props, destroyOnDelete: true }, output)));
  expect(fake.count("DELETE", "/v2/box/box-1")).toBe(1);
});

bunTest("observed immutable drift fails rather than destroying or lying about size", async () => {
  fake.seed().size = "large";
  await expect(run(boxProviderService(options).reconcile(input()))).rejects.toThrow("Observed Box size/runtime differs");
  expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});

bunTest("Preview fails closed on existing token/auth drift; only explicit rotate deletes then recreates", async () => {
  fake.seed();
  const provider = previewProviderService(options);
  const request = (output?: BoxPreviewAttributes, rotate?: string) => ({ ...metadata, news: { boxId: "box-1", rotate }, olds: undefined, output, session, bindings: [] });
  let output = await run(provider.reconcile(request()));
  expect(Redacted.value(output.token!)).toBe("offline-token-1");
  output = await run(provider.reconcile(request(output)));
  expect(fake.previewGenerations).toBe(1);
  const read = (prior?: BoxPreviewAttributes) => run(provider.read!({ ...metadata, olds: { boxId: "box-1" }, output: prior }));
  expect(Unowned.is(await read())).toBe(true);
  fake.previews.get("box-1")![0].bearer_token = false;
  const drifted = await read(output);
  expect(drifted?.token).toBeUndefined();
  await expect(run(provider.reconcile(request(drifted)))).rejects.toThrow("explicitly bump Upstash.BoxPreview rotate");
  await expect(run(provider.reconcile(request({ ...output, token: undefined })))).rejects.toThrow("no usable saved bearer token");
  await expect(run(provider.reconcile(request({ ...output, token: Redacted.make("") })))).rejects.toThrow("no usable saved bearer token");
  expect(fake.previewGenerations).toBe(1);
  output = await run(provider.reconcile(request(output, "rotation-1")));
  expect(Redacted.value(output.token!)).toBe("offline-token-2");
  expect(output.rotate).toBe("rotation-1");
  await run(provider.reconcile(request(output, "rotation-1")));
  expect(fake.previewGenerations).toBe(2);
  fake.previews.get("box-1")![0].url = "https://offline.invalid/drift";
  expect((await read(output))?.token).toBeUndefined();
  await expect(run(provider.reconcile(request(output, "rotation-1")))).rejects.toThrow("no usable saved bearer token");
  output = await run(provider.reconcile(request(output, "rotation-2")));
  expect(fake.previewGenerations).toBe(3);
  const mutations = fake.calls.filter(c => c.method !== "GET").map(c => c.method);
  expect(mutations).toEqual(["POST", "DELETE", "POST", "DELETE", "POST"]);
  await run(provider.delete({ ...metadata, olds: { boxId: "box-1" }, output, session, bindings: [] }));
  await run(provider.delete({ ...metadata, olds: { boxId: "box-1" }, output, session, bindings: [] }));
  expect(fake.count("DELETE", "/v2/box/box-1/preview/3774")).toBe(3);
});

bunTest("BoxApi exec uses SDK wire shape and failures do not expose command output or response bodies", async () => {
  fake.seed();
  const api = new BoxApi(options);
  expect(await api.exec("box-1", "printf hello")).toBe("ok\n");
  expect(fake.calls.at(-1)?.body).toEqual({ command: ["sh", "-c", "printf hello"] });
  fake.execStdoutOnly = true;
  expect(await api.exec("box-1", "printf hello")).toBe("ok\n");
  fake.execMissingOutput = true;
  await expect(api.exec("box-1", "printf hello")).rejects.toThrow("exec invalid output");
  fake.execMissingOutput = false;
  fake.execExit = 3; fake.execOutput = "DO-NOT-LEAK";
  await expect(api.exec("box-1", "DO-NOT-LEAK")).rejects.toThrow("exec exit 3");
  fake.responseError = true;
  try { await api.request("GET", "/v2/box/box-1"); throw new Error("expected failure"); }
  catch (error) { expect(String(error)).toContain("HTTP 500"); expect(String(error)).not.toContain("DO-NOT-LEAK"); }
});

bunTest("BoxApi files/write encodes binary chunks no larger than 512 KiB and assembles safely", async () => {
  fake.seed();
  const api = new BoxApi(options);
  const bytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 31);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await api.write("box-1", "a ' quoted; file", bytes);
  const writes = fake.calls.filter((c) => c.path.endsWith("/files/write"));
  expect(writes).toHaveLength(3);
  const decoded = writes.map((c) => Buffer.from(c.body.content as string, "base64"));
  expect(decoded.map((b) => b.length)).toEqual([FILE_CHUNK_BYTES, FILE_CHUNK_BYTES, 31]);
  expect(Buffer.concat(decoded)).toEqual(Buffer.from(bytes));
  expect(writes.every((c) => c.body.encoding === "base64" && !Object.hasOwn(c.body, "offset"))).toBe(true);
  const commands = fake.calls.filter((c) => c.path.endsWith("/exec")).map((c) => (c.body.command as string[])[2]);
  expect(commands).toHaveLength(5);
  writes.forEach((write, index) => {
    expect(commands[index]).toStartWith("chmod 600 -- ");
    expect(commands[index]).toContain((write.body.path as string).replaceAll("'", "'\\''"));
  });
  expect(commands[3]).toStartWith("umask 077 && cat -- ");
  expect(commands[3]).toContain(" && chmod 600 -- ");
  expect(commands[3]).toContain(" && mv -- ");
  expect(commands[3]).toContain("'\\''"); expect(commands[4]).toContain("rm -f -- ");
});

bunTest("BoxApi handles empty files and cleans up even after failed chunk chmod", async () => {
  fake.seed(); const api = new BoxApi(options);
  await api.write("box-1", "empty", new Uint8Array());
  expect(fake.calls.find((c) => c.path.endsWith("/files/write"))?.body.content).toBe("");
  fake.calls = []; fake.execExit = 7;
  await expect(api.write("box-1", "fail", new Uint8Array([0, 255]))).rejects.toThrow("exec exit 7");
  expect(fake.count("POST", "/v2/box/box-1/exec")).toBe(2);
});

bunTest("BoxApi cleans all restricted chunks and assembled ciphertext after failed assembly", async () => {
  fake.seed(); fake.execFailAssembly = true;
  const api = new BoxApi(options);
  const ciphertext = new TextEncoder().encode("age-encryption.org/v1\noffline-ciphertext");
  await expect(api.write("box-1", "token.age", ciphertext)).rejects.toThrow("exec exit 7");
  const commands = fake.calls.filter((c) => c.path.endsWith("/exec")).map((c) => (c.body.command as string[])[2]);
  expect(commands).toHaveLength(3);
  expect(commands[0]).toStartWith("chmod 600 -- ");
  expect(commands[1]).toStartWith("umask 077 && cat -- ");
  expect(commands[2]).toStartWith("rm -f -- ");
  expect(commands[2]).toContain(".assembled");
  expect(commands.join("\n")).not.toContain("offline-ciphertext");
});

bunTest("providers exposes both actual Provider tags alongside the collection", async () => {
  await run(Effect.gen(function* () {
    expect(yield* Box.Provider).toBeDefined();
    expect(yield* BoxPreview.Provider).toBeDefined();
  }).pipe(Effect.provide(providers(options))));
  expect(fake.calls).toHaveLength(0);
});

bunTest("BoxApi/provider construction is inert, no credential or network operation at import time", () => {
  new BoxApi(); boxProviderService(); previewProviderService(); providers();
  expect(fake.calls).toHaveLength(0);
});
