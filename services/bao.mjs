import * as filesystem from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const address = 'https://bao.maccrae.family';
export const role = 'agent-remote-agent';
export const enrollRequired = 'enroll required: run mise run agent:enroll on the operator machine';
export const day = 24 * 60 * 60 * 1000;
const rolePath = `auth/approle/role/${role}`;
// Keep only the HTTP status, never a response body or underlying cause.
export class RequestError extends Error {
  constructor(status) { super('OpenBao request failed (no response logged)'); this.status = status; }
}
export async function request(path, data, token) {
  try {
    const response = await fetch(`${address}/v1/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Vault-Token': token } : {}) },
      body: JSON.stringify(data), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RequestError(response.status); }
    return response.status === 204 ? {} : await response.json();
  } catch (error) { throw error instanceof RequestError ? error : new RequestError(); }
}
export function controller({ home = process.env.HOME, api = request, now = Date.now, fs = filesystem,
  log = message => console.error(message),
  decrypt = path => execFileSync('age', ['-d', '-i', join(home, '.config/fnox/age.txt'), path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  const root = join(home, '.remote-agent'), directory = join(root, 'bao');
  const file = name => join(directory, name);
  function regular(path) {
    try { const stat = fs.lstatSync(path); return stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size > 0; }
    catch { return false; }
  }
  function absent(path) {
    try { fs.lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  function syncDirectory(path) {
    const fd = fs.openSync(path, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function remove(path) {
    if (!absent(path)) { fs.unlinkSync(path); syncDirectory(dirname(path)); }
  }
  function privateDirectory(path) {
    if (absent(path)) { fs.mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
    if (!fs.lstatSync(path).isDirectory() || fs.lstatSync(path).isSymbolicLink()) throw new Error('Refusing non-directory OpenBao state');
    fs.chmodSync(path, 0o700);
  }
  function prepare() { privateDirectory(root); privateDirectory(directory); }
  function checkFile(path) {
    if (!absent(path) && !regular(path)) throw new Error('Refusing non-private/non-regular OpenBao file');
  }
  function preflight() {
    for (const name of ['role-id', 'secret-id', 'metadata.json', 'agent.json', 'next-secret-id', 'rotation.json', 'retire.json', 'install.json']) checkFile(file(name));
    checkSink();
    fs.accessSync(directory, fs.constants.W_OK);
    fs.accessSync(home, fs.constants.W_OK);
    // Exercise creation, flushing and renaming before consuming the wrapper.
    const probe = file(`preflight-${randomUUID()}`);
    try { write(probe, 'preflight'); } finally { remove(probe); }
  }
  function write(path, value) {
    checkFile(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path);
      syncDirectory(dirname(path));
    } finally { remove(temporary); }
  }
  function json(name) {
    if (!regular(file(name))) throw new Error(enrollRequired);
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { throw new Error(enrollRequired); }
  }
  function optional(name) { return absent(file(name)) ? undefined : json(name); }
  function valid(meta) {
    return typeof meta?.secret_id_accessor === 'string' && meta.secret_id_accessor.length > 0 &&
      Number.isFinite(meta.issued_at) && meta.issued_at <= now() && now() - meta.issued_at < 30 * day;
  }
  function status() {
    try {
      prepare();
      return absent(file('install.json')) && regular(file('role-id')) && regular(file('secret-id')) && valid(json('metadata.json'));
    } catch { return false; }
  }
  function requireEnrollment() { if (!status()) throw new Error(enrollRequired); }
  function metadata(data, issuedAt) {
    if (typeof data?.secret_id !== 'string' || !data.secret_id || typeof data.secret_id_accessor !== 'string' || !data.secret_id_accessor) throw new Error('Invalid OpenBao secret_id response (no response logged)');
    const meta = { secret_id_accessor: data.secret_id_accessor, issued_at: issuedAt };
    if (!valid(meta)) throw new Error('Invalid OpenBao issue time');
    return meta;
  }
  function summary(meta) { return { role, secret_id_accessor: meta.secret_id_accessor, expires_at: new Date(meta.issued_at + 30 * day).toISOString() }; }
  function checkSink() {
    const sink = join(home, '.vault-token');
    if (!absent(sink) && !regular(sink)) throw new Error('Refusing non-private/non-regular OpenBao token sink');
    return sink;
  }
  function agentConfig() {
    const sink = checkSink();
    return JSON.stringify({
      vault: { address },
      auto_auth: {
        method: { type: 'approle', mount_path: 'auth/approle', config: {
          role_id_file_path: file('role-id'), secret_id_file_path: file('secret-id'), remove_secret_id_file_after_reading: false,
        } },
        sink: [{ type: 'file', config: { path: sink, mode: 0o600 } }],
      },
    });
  }
  function pending() {
    const list = optional('retire.json') ?? [];
    if (!Array.isArray(list) || list.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid retirement list; reconcile private state');
    return list;
  }
  function queue(accessors, current) {
    const list = [...new Set([...pending(), ...accessors].filter(value => typeof value === 'string' && value && value !== current))];
    write(file('retire.json'), JSON.stringify(list));
  }
  async function destroy(accessor, token) {
    try { await api(`${rolePath}/secret-id-accessor/destroy`, { secret_id_accessor: accessor }, token); return true; }
    catch {
      // OpenBao 2.7.1 answers 500 when destroying an unknown (expired or already
      // destroyed) accessor, so confirm absence with a lookup, which answers 404.
      try { await api(`${rolePath}/secret-id-accessor/lookup`, { secret_id_accessor: accessor }, token); return false; }
      catch (error) { return error instanceof RequestError && error.status === 404; }
    }
  }
  async function retire(token) {
    const current = json('metadata.json').secret_id_accessor;
    // Persist each completion. A crash only repeats an idempotent destroy.
    let list = pending().filter(value => value !== current);
    if (list.length !== pending().length) write(file('retire.json'), JSON.stringify(list));
    for (const accessor of [...list]) {
      if (await destroy(accessor, token)) {
        list = list.filter(value => value !== accessor);
        write(file('retire.json'), JSON.stringify(list));
      }
    }
    if (list.length) log('OpenBao accessor retirement pending; retrying next daily cycle (no response logged)');
  }
  function install() {
    const staged = optional('install.json');
    if (!staged) return;
    if (!valid(staged.meta) || typeof staged.role_id !== 'string' || !staged.role_id || typeof staged.secret_id !== 'string' || !staged.secret_id || !Array.isArray(staged.previous)) throw new Error('Invalid enrollment journal; reconcile private state');
    // The durable journal allows roll-forward after any interrupted write. Until
    // it is removed, status refuses to claim that enrollment is installed.
    queue(staged.previous, staged.meta.secret_id_accessor);
    write(file('role-id'), staged.role_id);
    write(file('secret-id'), staged.secret_id);
    write(file('metadata.json'), JSON.stringify(staged.meta));
    write(file('agent.json'), agentConfig());
    remove(file('next-secret-id')); remove(file('rotation.json'));
    remove(file('install.json'));
  }
  function config() {
    prepare(); preflight(); install(); requireEnrollment();
    write(file('agent.json'), agentConfig());
  }
  async function enroll(path) {
    prepare(); preflight(); install();
    if (dirname(path) !== root || !/^bao-enroll-[a-f0-9-]+\.age$/.test(path.slice(root.length + 1)) || !regular(path)) throw new Error('Refusing non-private enrollment upload');
    const old = optional('metadata.json'), rotation = optional('rotation.json');
    const previous = [...pending(), old?.secret_id_accessor, rotation?.next?.secret_id_accessor, rotation?.old_accessor].filter(value => typeof value === 'string' && value);
    let payload;
    try { payload = JSON.parse(decrypt(path)); }
    catch { throw new Error('Enrollment decryption failed (no response logged)'); }
    finally { remove(path); }
    if (typeof payload.role_id !== 'string' || !payload.role_id || typeof payload.wrapping_token !== 'string' || !payload.wrapping_token) throw new Error('Invalid enrollment payload');
    let unwrapped;
    try { unwrapped = await api('sys/wrapping/unwrap', {}, payload.wrapping_token); }
    catch { throw new Error('Wrapping token already used or expired; treat unexpected failure as possible interception. Re-run mise run agent:enroll on the operator machine'); }
    const meta = metadata(unwrapped.data, payload.issued_at);
    let login;
    try { login = await api('auth/approle/login', { role_id: payload.role_id, secret_id: unwrapped.data.secret_id }); }
    catch { throw new Error('AppRole verification login failed (no response logged)'); }
    const token = login?.auth?.client_token;
    if (typeof token !== 'string' || !token) throw new Error('AppRole verification login failed (no response logged)');
    try {
      write(file('install.json'), JSON.stringify({ role_id: payload.role_id, secret_id: unwrapped.data.secret_id, meta, previous }));
      install();
      // Only a fully flushed installation authorizes retiring prior identities.
      await retire(token);
    } catch { throw new Error('OpenBao enrollment persistence failed; reconcile private state (no response logged)'); }
    finally {
      try { await api('auth/token/revoke-self', {}, token); }
      catch { log('OpenBao verification token revocation failed; installed identity retained (no response logged)'); }
    }
    return summary(meta);
  }
  async function rotate() {
    prepare(); preflight(); install(); requireEnrollment();
    const sink = checkSink();
    const sinkToken = () => {
      if (!regular(sink)) throw new Error('OpenBao token sink unavailable; rotation will retry next cycle');
      return fs.readFileSync(sink, 'utf8').trim();
    };
    // Retirement is independent of identity age, including after re-enrollment.
    if (pending().length) await retire(sinkToken());
    let journal = optional('rotation.json');
    if (!journal) {
      const old = json('metadata.json');
      if (now() - old.issued_at < 7 * day) return { rotated: false };
      const token = sinkToken(), issuedAt = now();
      const result = await api(`${rolePath}/secret-id`, {}, token);
      const next = metadata(result.data, issuedAt);
      journal = { next, old_accessor: old.secret_id_accessor };
      try {
        write(file('next-secret-id'), result.data.secret_id);
        write(file('rotation.json'), JSON.stringify(journal));
      } catch {
        // Nothing was published. Attempt compensation even if the filesystem
        // that rejected staging is still unavailable. Retain failed destruction.
        if (!(await destroy(next.secret_id_accessor, token))) queue([next.secret_id_accessor], old.secret_id_accessor);
        remove(file('rotation.json')); remove(file('next-secret-id'));
        throw new Error('OpenBao rotation staging failed; issued accessor retirement recorded (no response logged)');
      }
    }
    if (!valid(journal.next) || typeof journal.old_accessor !== 'string' || journal.old_accessor === journal.next.secret_id_accessor) throw new Error('Invalid rotation journal; reconcile private state');
    // Journal precedes publication and retains both accessors until completion.
    if (!absent(file('next-secret-id'))) {
      if (!regular(file('next-secret-id'))) throw new Error('Refusing non-private staged secret_id');
      fs.renameSync(file('next-secret-id'), file('secret-id'));
      syncDirectory(directory);
    }
    write(file('metadata.json'), JSON.stringify(journal.next));
    queue([journal.old_accessor], journal.next.secret_id_accessor);
    await retire(sinkToken());
    remove(file('rotation.json'));
    return { rotated: true, ...summary(journal.next) };
  }
  return { enroll, rotate, status, config, directory };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [action, path] = process.argv.slice(2), bao = controller();
    if (action === 'enroll') console.log(JSON.stringify(await bao.enroll(path)));
    else if (action === 'rotate') console.log(JSON.stringify(await bao.rotate()));
    else if (action === 'status') console.log(JSON.stringify({ enrolled: bao.status() }));
    else if (action === 'config') bao.config();
    else throw new Error('Unknown OpenBao task');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
