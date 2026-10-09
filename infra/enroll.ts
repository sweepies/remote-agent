import { execFileSync } from "node:child_process";
import { Encrypter } from "age-encryption";
import { BoxApi } from "./box-api.ts";
import { lastJSON, quote, type BootstrapApi } from "./Bootstrap.ts";
import { BOX_LABEL } from "./inputs.ts";
import { observeBox } from "./Upstash.ts";

export const BAO_ADDR = "https://bao.maccrae.family";
export const ROLE = "agent-remote-agent";
export const ROLE_SETTINGS = {
  token_policies: ["admin"], token_ttl: "1h", token_max_ttl: "24h", token_type: "service",
  secret_id_ttl: "720h", secret_id_num_uses: 0, bind_secret_id: true,
};
export type Bao = (args: string[], input?: unknown) => Promise<any>;
// The human's default token helper is used; no token is read by this program.
export const bao: Bao = async (args, input) => {
  const env: NodeJS.ProcessEnv = { ...process.env, BAO_ADDR };
  delete env.BAO_TOKEN;
  delete env.VAULT_TOKEN;
  try {
    const output = execFileSync("bao", args, {
      env, input: input === undefined ? undefined : JSON.stringify(input),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : undefined;
  } catch { throw new Error("OpenBao enrollment operation failed; check the operator's bao OIDC session and permissions (no response logged)"); }
};
export async function enroll(api: BootstrapApi & Pick<BoxApi, "request">, options: {
  bao?: Bao; encrypt?: (recipient: string, payload: string) => Promise<Uint8Array>;
} = {}) {
  const box = await observeBox(api, BOX_LABEL);
  if (!box) throw new Error("No remote-agent Box found; bootstrap it before enrollment");
  // Resolve the public recipient before issuing the five-minute wrapping token.
  const recipient = (await api.exec(box.id, 'cd "$HOME"; "$HOME/.local/bin/mise" exec -- age-keygen -y "$HOME/.config/fnox/age.txt"')).trim();
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error("Box returned an invalid age recipient");
  const run = options.bao ?? bao;
  const rolePath = `auth/approle/role/${ROLE}`;
  await run(["write", "-format=json", rolePath, "-"], ROLE_SETTINGS);
  const roleId = (await run(["read", "-format=json", `${rolePath}/role-id`]))?.data?.role_id;
  if (typeof roleId !== "string" || !roleId) throw new Error("OpenBao did not return a role_id");
  const wrapped = (await run(["write", "-format=json", "-wrap-ttl=5m", "-force", `${rolePath}/secret-id`]))?.wrap_info;
  const issuedAt = Date.parse(wrapped?.creation_time);
  if (typeof wrapped?.token !== "string" || !wrapped.token || !Number.isFinite(issuedAt)) throw new Error("OpenBao did not return wrapping metadata");
  const encrypt = options.encrypt ?? (async (recipient, payload) => {
    const encrypter = new Encrypter(); encrypter.addRecipient(recipient);
    return encrypter.encrypt(payload);
  });
  // Only the wrapper and public role/issue time leave the operator machine.
  const ciphertext = await encrypt(recipient, JSON.stringify({ role_id: roleId, wrapping_token: wrapped.token, issued_at: issuedAt }));
  const path = `/workspace/home/.remote-agent/bao-enroll-${crypto.randomUUID()}.age`;
  await api.exec(box.id, 'umask 077; mkdir -p /workspace/home/.remote-agent; chmod 700 /workspace/home/.remote-agent');
  try {
    await api.write(box.id, path, ciphertext);
    const output = await api.exec(box.id, `cd "$HOME"; "$HOME/.local/bin/mise" run --quiet remote-agent-bao-enroll -- ${quote(path)}`);
    // Whitelist fields; never forward arbitrary Box output to the terminal.
    const result = lastJSON(output);
    if (result.role !== ROLE || typeof result.secret_id_accessor !== "string" || typeof result.expires_at !== "string") throw new Error("Invalid Box enrollment status");
    return { role: ROLE, secret_id_accessor: result.secret_id_accessor, expires_at: result.expires_at };
  } catch {
    throw new Error("Box enrollment failed. A wrapping token may have been used or expired: treat unexpected unwrap failure as possible interception. Inspect the private bao service log and re-run mise run agent:enroll");
  } finally { await api.exec(box.id, `rm -f -- ${quote(path)}`).catch(() => {}); }
}
if (import.meta.main) {
  try {
    if (Bun.env.CI === "true") throw new Error("AppRole enrollment is human-only and cannot run in CI");
    console.log(JSON.stringify(await enroll(new BoxApi())));
  }
  catch (error) { console.error(error instanceof Error ? error.message : "Enrollment failed"); process.exitCode = 1; }
}
