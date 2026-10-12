import { afterEach, beforeEach, expect, test } from "bun:test";
import { enroll, ROLE, ROLE_SETTINGS, type Bao } from "./enroll.ts";

const address = "https://openbao.example";
let previousAddress: string | undefined;
beforeEach(() => { previousAddress = process.env.BAO_ADDR; process.env.BAO_ADDR = address; });
afterEach(() => {
  if (previousAddress === undefined) delete process.env.BAO_ADDR;
  else process.env.BAO_ADDR = previousAddress;
});

function fixture({ entity = { id: "offline-entity-id", name: ROLE } as { id: string; name: string } | null, named = null as { id: string; name: string } | null } = {}) {
  const wrapper = "offline-wrapping-token", roleId = "offline-role-id";
  const calls: { args: string[]; input?: unknown }[] = [], commands: string[] = [], writes: Uint8Array[] = [], requests: string[] = [];
  let boxes = [{ id: "unit-box", status: "running" }], fail = false;
  const bao: Bao = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "read" && args[2].endsWith("/role-id")) return { data: { role_id: roleId } };
    if (args[2] === "sys/auth") return { data: { "approle/": { accessor: "offline-approle-accessor" } } };
    if (args[2] === "identity/lookup/entity") {
      const data = args[3].startsWith("alias_name=") ? entity : named;
      return data ? { data } : undefined;
    }
    if (args[2] === `identity/entity/name/${ROLE}`) return { data: { id: "offline-named-entity-id" } };
    if (args.includes("-wrap-ttl=5m")) return { wrap_info: { token: wrapper, creation_time: "2026-01-01T00:00:00Z" } };
  };
  const api = {
    request: async <T>(_method: string, path: string) => { requests.push(path); expect(path).toBe("/v2/box?label=remote-agent"); return boxes as T; },
    exec: async (_id: string, command: string) => {
      commands.push(command);
      if (command.includes("age-keygen -y")) return "age1" + "x".repeat(58);
      if (command.includes("remote-agent-bao-enroll")) {
        if (fail) throw new Error(wrapper);
        return `mise WARN  fixture warning\n${JSON.stringify({ role: ROLE, secret_id_accessor: "public-accessor", expires_at: "2026-01-31T00:00:00Z" })}\n`;
      }
      return "";
    },
    write: async (_id: string, path: string, bytes: Uint8Array) => {
      expect(path).toMatch(/^\/workspace\/home\/\.remote-agent\/bao-enroll-[a-f0-9-]+\.age$/);
      writes.push(bytes);
    },
  };
  const encrypt = async (_recipient: string, payload: string) => {
    expect(JSON.parse(payload)).toEqual({ address, role_id: roleId, wrapping_token: wrapper, issued_at: Date.parse("2026-01-01T00:00:00Z") });
    return new TextEncoder().encode("age-ciphertext-only");
  };
  return { api, bao, encrypt, calls, commands, writes, requests, wrapper, missing: () => { boxes = []; }, ambiguous: () => { boxes.push({ id: "second", status: "running" }); }, fail: () => { fail = true; } };
}
test("missing or invalid BAO_ADDR fails before any operator or Box operation", async () => {
  for (const value of [undefined, "", "http://openbao.example", "https://openbao.example/path", "https://openbao.example?q=1", "https://user:fixture-password@openbao.example"]) {
    if (value === undefined) delete process.env.BAO_ADDR;
    else process.env.BAO_ADDR = value;
    const f = fixture();
    await expect(enroll(f.api, f)).rejects.toThrow(value ? "absolute HTTPS URL" : "BAO_ADDR=… mise run agent:enroll");
    expect(f.requests).toHaveLength(0); expect(f.commands).toHaveLength(0);
    expect(f.calls).toHaveLength(0); expect(f.writes).toHaveLength(0);
  }
});
test("human enrollment leaves an already-correct alias entity unchanged and transports only an encrypted response wrapper", async () => {
  const f = fixture();
  const result = await enroll(f.api, f);
  expect(f.calls).toEqual([
    { args: ["write", "-format=json", `auth/approle/role/${ROLE}`, "-"], input: ROLE_SETTINGS },
    { args: ["read", "-format=json", `auth/approle/role/${ROLE}/role-id`], input: undefined },
    { args: ["read", "-format=json", "sys/auth"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", "alias_name=offline-role-id", "alias_mount_accessor=offline-approle-accessor"], input: undefined },
    { args: ["write", "-format=json", "-wrap-ttl=5m", "-force", `auth/approle/role/${ROLE}/secret-id`], input: undefined },
  ]);
  expect(f.writes.map(bytes => new TextDecoder().decode(bytes))).toEqual(["age-ciphertext-only"]);
  expect(f.commands.join("\n")).not.toContain(f.wrapper);
  expect(f.commands.join("\n")).not.toContain(address);
  expect(JSON.stringify(result)).not.toContain(f.wrapper);
  expect(result.secret_id_accessor).toBe("public-accessor");
  expect(f.commands.at(-1)).toStartWith("rm -f --");
});
test("existing alias with an automatic entity name is renamed after checking name ownership", async () => {
  const f = fixture({ entity: { id: "offline-entity-id", name: "entity_automatic" } });
  await enroll(f.api, f);
  expect(f.calls).toEqual([
    { args: ["write", "-format=json", `auth/approle/role/${ROLE}`, "-"], input: ROLE_SETTINGS },
    { args: ["read", "-format=json", `auth/approle/role/${ROLE}/role-id`], input: undefined },
    { args: ["read", "-format=json", "sys/auth"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", "alias_name=offline-role-id", "alias_mount_accessor=offline-approle-accessor"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", `name=${ROLE}`], input: undefined },
    { args: ["write", "-format=json", "identity/entity/id/offline-entity-id", `name=${ROLE}`], input: undefined },
    { args: ["write", "-format=json", "-wrap-ttl=5m", "-force", `auth/approle/role/${ROLE}/secret-id`], input: undefined },
  ]);
});
test("missing alias upserts the named entity then binds the role id to its mount accessor", async () => {
  const f = fixture({ entity: null });
  await enroll(f.api, f);
  expect(f.calls).toEqual([
    { args: ["write", "-format=json", `auth/approle/role/${ROLE}`, "-"], input: ROLE_SETTINGS },
    { args: ["read", "-format=json", `auth/approle/role/${ROLE}/role-id`], input: undefined },
    { args: ["read", "-format=json", "sys/auth"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", "alias_name=offline-role-id", "alias_mount_accessor=offline-approle-accessor"], input: undefined },
    { args: ["write", "-format=json", "identity/entity", `name=${ROLE}`], input: undefined },
    { args: ["read", "-format=json", `identity/entity/name/${ROLE}`], input: undefined },
    { args: ["write", "-format=json", "identity/entity-alias", "name=offline-role-id", "mount_accessor=offline-approle-accessor", "canonical_id=offline-named-entity-id"], input: undefined },
    { args: ["write", "-format=json", "-wrap-ttl=5m", "-force", `auth/approle/role/${ROLE}/secret-id`], input: undefined },
  ]);
});
test("name conflict refuses a rename and credential issuance without logging identity responses", async () => {
  const f = fixture({ entity: { id: "offline-entity-id", name: "entity_automatic" }, named: { id: "fixture-sensitive-other-id", name: ROLE } });
  await expect(enroll(f.api, f)).rejects.toThrow("belongs to a different entity");
  expect(f.calls).toEqual([
    { args: ["write", "-format=json", `auth/approle/role/${ROLE}`, "-"], input: ROLE_SETTINGS },
    { args: ["read", "-format=json", `auth/approle/role/${ROLE}/role-id`], input: undefined },
    { args: ["read", "-format=json", "sys/auth"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", "alias_name=offline-role-id", "alias_mount_accessor=offline-approle-accessor"], input: undefined },
    { args: ["write", "-format=json", "identity/lookup/entity", `name=${ROLE}`], input: undefined },
  ]);
  await expect(enroll(f.api, f)).rejects.not.toThrow("fixture-sensitive-other-id");
  expect(f.writes).toHaveLength(0);
});
test("invalid mount or entity responses fail before issuing credentials without logging responses", async () => {
  for (const [path, response, message] of [
    ["sys/auth", { data: { "approle/": { accessor: null, sensitive: "fixture-sensitive-response" } } }, "mount accessor"],
    ["identity/lookup/entity", { data: { id: null, sensitive: "fixture-sensitive-response" } }, "alias entity id"],
    [`identity/entity/name/${ROLE}`, { data: { id: null, sensitive: "fixture-sensitive-response" } }, "named entity id"],
  ] as const) {
    const f = fixture({ entity: null });
    const options = { ...f, bao: async (args: string[], input?: unknown) => args[2] === path ? response : f.bao(args, input) };
    await expect(enroll(f.api, options)).rejects.toThrow(message);
    await expect(enroll(f.api, options)).rejects.not.toThrow("fixture-sensitive-response");
    expect(f.calls.some(call => call.args.includes("-wrap-ttl=5m"))).toBe(false);
    expect(f.writes).toHaveLength(0);
  }
});
test("missing or ambiguous identity fails before issuing any agent credential", async () => {
  for (const kind of ["missing", "ambiguous"] as const) {
    const f = fixture(); f[kind]();
    await expect(enroll(f.api, f)).rejects.toThrow(kind === "missing" ? "No remote-agent Box" : "Ambiguous Box identity");
    expect(f.calls).toHaveLength(0); expect(f.writes).toHaveLength(0);
  }
});
test("remote errors are sanitized and upload cleanup is attempted", async () => {
  const f = fixture(); f.fail();
  await expect(enroll(f.api, f)).rejects.toThrow("possible interception");
  expect(f.commands.at(-1)).toStartWith("rm -f --");
});
test("invalid public recipient and missing wrapper fail before uploading", async () => {
  const f = fixture();
  await expect(enroll({ ...f.api, exec: async () => "invalid" }, f)).rejects.toThrow("invalid age recipient");
  expect(f.calls).toHaveLength(0);
  await expect(enroll(f.api, { ...f, bao: async (args, input) => args.includes("-wrap-ttl=5m") ? {} : f.bao(args, input) })).rejects.toThrow("wrapping metadata");
  expect(f.writes).toHaveLength(0);
});
