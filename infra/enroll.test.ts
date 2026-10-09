import { expect, test } from "bun:test";
import { enroll, ROLE, ROLE_SETTINGS, type Bao } from "./enroll.ts";

function fixture() {
  const wrapper = "offline-wrapping-token", roleId = "offline-role-id";
  const calls: { args: string[]; input?: unknown }[] = [], commands: string[] = [], writes: Uint8Array[] = [];
  let boxes = [{ id: "unit-box", status: "running" }], fail = false;
  const bao: Bao = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "read") return { data: { role_id: roleId } };
    if (args.includes("-wrap-ttl=5m")) return { wrap_info: { token: wrapper, creation_time: "2026-01-01T00:00:00Z" } };
  };
  const api = {
    request: async <T>(_method: string, path: string) => { expect(path).toBe("/v2/box?label=remote-agent"); return boxes as T; },
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
    expect(JSON.parse(payload)).toEqual({ role_id: roleId, wrapping_token: wrapper, issued_at: Date.parse("2026-01-01T00:00:00Z") });
    return new TextEncoder().encode("age-ciphertext-only");
  };
  return { api, bao, encrypt, calls, commands, writes, wrapper, missing: () => { boxes = []; }, ambiguous: () => { boxes.push({ id: "second", status: "running" }); }, fail: () => { fail = true; } };
}
test("human enrollment configures the role and transports only an encrypted response wrapper", async () => {
  const f = fixture();
  const result = await enroll(f.api, f);
  expect(f.calls).toEqual([
    { args: ["write", "-format=json", `auth/approle/role/${ROLE}`, "-"], input: ROLE_SETTINGS },
    { args: ["read", "-format=json", `auth/approle/role/${ROLE}/role-id`], input: undefined },
    { args: ["write", "-format=json", "-wrap-ttl=5m", "-force", `auth/approle/role/${ROLE}/secret-id`], input: undefined },
  ]);
  expect(f.writes.map(bytes => new TextDecoder().decode(bytes))).toEqual(["age-ciphertext-only"]);
  expect(f.commands.join("\n")).not.toContain(f.wrapper);
  expect(JSON.stringify(result)).not.toContain(f.wrapper);
  expect(result.secret_id_accessor).toBe("public-accessor");
  expect(f.commands.at(-1)).toStartWith("rm -f --");
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
  await expect(enroll(f.api, { ...f, bao: async args => args[0] === "read" ? { data: { role_id: "public-role" } } : {} })).rejects.toThrow("wrapping metadata");
  expect(f.writes).toHaveLength(0);
});
