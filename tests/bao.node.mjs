import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs';
import { mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controller, day, role, enrollRequired, RequestError, request } from '../services/bao.mjs';
import { serve } from '../services/bao-service.mjs';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'remote-agent-bao-'));
  t.after(() => rmSync(home, { recursive: true }));
  const root = join(home, '.remote-agent'), directory = join(root, 'bao');
  mkdirSync(root, { mode: 0o700 });
  let clock = Date.parse('2026-01-01T00:00:00Z'), failure, fsFailure, inspection, enrollment = 0;
  const messages = [];
  const fs = { ...filesystem, renameSync: (source, target) => {
    if (fsFailure?.('rename', target)) throw new Error('fixture filesystem failure');
    return filesystem.renameSync(source, target);
  }, unlinkSync: path => {
    if (fsFailure?.('unlink', path)) throw new Error('fixture filesystem failure');
    return filesystem.unlinkSync(path);
  } };
  const calls = [], oldSecret = 'fixture-secret-id', newSecret = 'fixture-next-secret-id';
  const upload = join(root, 'bao-enroll-1234.age');
  const api = async (path, data, token) => {
    calls.push({ path, data, token });
    inspection?.(path, data, token);
    const error = failure?.(path, data);
    if (error) throw error instanceof Error ? error : new Error('sensitive error response');
    if (path === 'sys/wrapping/unwrap') {
      enrollment++;
      return { data: { secret_id: enrollment === 1 ? oldSecret : `fixture-enrolled-secret-${enrollment}`, secret_id_accessor: enrollment === 1 ? 'old-accessor' : `enrolled-${enrollment}-accessor` } };
    }
    if (path === 'auth/approle/login') return { auth: { client_token: 'fixture-verification-token' } };
    if (path.endsWith('/secret-id')) return { data: { secret_id: newSecret, secret_id_accessor: 'new-accessor' } };
    return {};
  };
  const bao = controller({ home, root, api, fs, log: message => messages.push(message), now: () => clock, decrypt: () => JSON.stringify({ role_id: 'fixture-role-id', wrapping_token: 'fixture-wrapper', issued_at: clock }) });
  const write = (path, value) => writeFileSync(path, value, { mode: 0o600 });
  const enroll = async () => { write(upload, 'ciphertext'); return bao.enroll(upload); };
  const token = () => write(join(home, '.vault-token'), 'fixture-current-token');
  return { home, root, directory, upload, bao, calls, oldSecret, newSecret, write, enroll, token, messages,
    advance: days => { clock += days * day; }, fail: fn => { failure = fn; },
    failFS: fn => { fsFailure = fn; }, inspect: fn => { inspection = fn; } };
}
test('box enrollment unwraps once, verifies, installs private files/config then revokes', async t => {
  const f = fixture(t);
  assert.equal(f.bao.status(), false);
  const result = await f.enroll();
  assert.equal(f.bao.status(), true);
  assert.equal(existsSync(f.upload), false);
  assert.deepEqual(f.calls.map(call => call.path), ['sys/wrapping/unwrap', 'auth/approle/login', 'auth/token/revoke-self']);
  assert.equal(f.calls[0].token, 'fixture-wrapper');
  assert.equal(f.calls[1].data.secret_id, f.oldSecret);
  assert.equal(f.calls[2].token, 'fixture-verification-token');
  assert.equal(result.role, role);
  assert.equal(result.secret_id_accessor, 'old-accessor');
  assert.equal(result.expires_at, '2026-01-31T00:00:00.000Z');
  const meta = readFileSync(join(f.directory, 'metadata.json'), 'utf8');
  assert.doesNotMatch(meta + JSON.stringify(result), /fixture-(secret|wrapper|verification)/);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  for (const name of ['role-id', 'secret-id', 'metadata.json', 'agent.json']) assert.equal(statSync(join(f.directory, name)).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(join(f.directory, 'agent.json'), 'utf8'));
  assert.deepEqual(config.vault, { address: 'https://bao.maccrae.family' });
  assert.equal(config.auto_auth.method.type, 'approle');
  assert.equal(config.auto_auth.method.config.remove_secret_id_file_after_reading, false);
  assert.equal(config.auto_auth.method.config.secret_id_file_path, join(f.directory, 'secret-id'));
  assert.deepEqual(config.auto_auth.sink, [{ type: 'file', config: { path: join(f.home, '.vault-token'), mode: 0o600 } }]);
});
test('already-used/expired wrapping token fails clearly, deletes upload and installs nothing', async t => {
  const f = fixture(t); f.fail(path => path === 'sys/wrapping/unwrap');
  await assert.rejects(f.enroll(), /already used or expired.*possible interception/);
  assert.equal(existsSync(f.upload), false);
  assert.equal(existsSync(join(f.directory, 'secret-id')), false);
  assert.equal(f.bao.status(), false);
});
test('failed login retains old identity; revoke failure retains the installed replacement', async t => {
  const f = fixture(t); await f.enroll();
  f.calls.length = 0;
  f.fail(path => path === 'auth/approle/login');
  await assert.rejects(f.enroll(), /verification login failed.*no response logged/);
  assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.oldSecret);
  assert.equal(f.calls.some(call => call.path.endsWith('/destroy')), false);
  f.fail(path => path === 'auth/token/revoke-self');
  f.inspect(path => {
    if (path.endsWith('/destroy') || path === 'auth/token/revoke-self') {
      assert.equal(f.bao.status(), true);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'metadata.json'), 'utf8')).secret_id_accessor, 'enrolled-3-accessor');
      assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), 'fixture-enrolled-secret-3');
      assert.equal(existsSync(join(f.directory, 'agent.json')), true);
    }
  });
  await f.enroll();
  assert.match(f.messages.at(-1), /revocation failed; installed identity retained/);
  assert.doesNotMatch(f.messages.join('\n'), /sensitive error|fixture-enrolled-secret|fixture-verification-token/);
  assert.equal(existsSync(f.upload), false);
});
test('re-enrollment destroys the replaced and any staged secret_id with the verification token', async t => {
  const f = fixture(t); await f.enroll();
  f.write(join(f.directory, 'metadata.json'), JSON.stringify({ secret_id_accessor: 'prior-accessor', issued_at: Date.parse('2026-01-01T00:00:00Z') }));
  f.write(join(f.directory, 'rotation.json'), JSON.stringify({ next: { secret_id_accessor: 'staged-accessor' }, old_accessor: 'prior-accessor' }));
  f.calls.length = 0;
  await f.enroll();
  const destroyed = f.calls.filter(call => call.path.endsWith('/secret-id-accessor/destroy'));
  assert.deepEqual(destroyed.map(call => call.data.secret_id_accessor).sort(), ['prior-accessor', 'staged-accessor']);
  assert.ok(destroyed.every(call => call.token === 'fixture-verification-token'));
  assert.equal(f.calls.at(-1).path, 'auth/token/revoke-self');
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
});
test('config refuses absent or 30-day-old enrollment, but 29-day enrollment is fresh', async t => {
  const f = fixture(t);
  assert.throws(() => f.bao.config(), new RegExp(enrollRequired));
  await f.enroll(); f.advance(29);
  assert.equal(f.bao.status(), true); f.bao.config();
  f.advance(1);
  assert.equal(f.bao.status(), false);
  assert.throws(() => f.bao.config(), new RegExp(enrollRequired));
  assert.equal(f.calls.length, 3, 'freshness/config never contact OpenBao');
});
test('rotation is cheap below seven days; publishes first then destroys old accessor', async t => {
  const f = fixture(t); await f.enroll(); f.calls.length = 0;
  assert.deepEqual(await f.bao.rotate(), { rotated: false });
  f.advance(6.99);
  assert.deepEqual(await f.bao.rotate(), { rotated: false });
  assert.deepEqual(f.calls, []);
  f.advance(0.01); f.token();
  const result = await f.bao.rotate();
  assert.equal(result.rotated, true);
  assert.deepEqual(f.calls.map(call => call.path), [`auth/approle/role/${role}/secret-id`, `auth/approle/role/${role}/secret-id-accessor/destroy`]);
  assert.deepEqual(f.calls[1].data, { secret_id_accessor: 'old-accessor' });
  assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.newSecret);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'metadata.json'), 'utf8')).secret_id_accessor, 'new-accessor');
  assert.equal(statSync(join(f.directory, 'secret-id')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
  assert.deepEqual(await f.bao.rotate(), { rotated: false });
});
test('failed issue retains old identity; failed destroy resumes without issuing again', async t => {
  const f = fixture(t); await f.enroll(); f.advance(7); f.token(); f.calls.length = 0;
  f.fail(path => path.endsWith('/secret-id'));
  await assert.rejects(f.bao.rotate());
  assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.oldSecret);
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
  f.fail(path => path.endsWith('/destroy'));
  await f.bao.rotate();
  assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.newSecret);
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), ['old-accessor']);
  assert.equal(statSync(join(f.directory, 'retire.json')).mode & 0o777, 0o600);
  const issues = f.calls.filter(call => call.path.endsWith('/secret-id')).length;
  f.fail(() => false);
  await f.bao.rotate();
  assert.equal(f.calls.filter(call => call.path.endsWith('/secret-id')).length, issues);
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
});
test('journal resumes a crash before secret publication', async t => {
  const f = fixture(t); await f.enroll(); f.advance(7); f.token(); f.calls.length = 0;
  const issuedAt = Date.parse('2026-01-08T00:00:00Z');
  f.write(join(f.directory, 'next-secret-id'), f.newSecret);
  f.write(join(f.directory, 'rotation.json'), JSON.stringify({ next: { issued_at: issuedAt, secret_id_accessor: 'new-accessor' }, old_accessor: 'old-accessor' }));
  await f.bao.rotate();
  assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.newSecret);
  assert.deepEqual(f.calls.map(call => call.path), [`auth/approle/role/${role}/secret-id-accessor/destroy`]);
});
test('token service checks rotation at start/daily, retries failure and follows agent lifetime', async () => {
  const children = [], messages = [];
  let daily, cancelled = 0;
  const launch = (_command, args) => {
    const child = new EventEmitter();
    child.args = args; child.kill = () => child.emit('close', 0);
    children.push(child);
    return child;
  };
  const abort = new AbortController();
  const running = serve({ launch, signal: abort.signal,
    every: (fn, ms) => { assert.equal(ms, day); daily = fn; return 'timer'; },
    cancel: () => cancelled++, log: message => messages.push(message),
  });
  assert.ok(children[0].args.includes('agent'));
  assert.deepEqual(children[1].args, ['run', '--quiet', 'remote-agent-bao-rotate']);
  daily(); assert.equal(children.length, 2, 'overlapping checks skipped');
  children[1].emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(messages[0], /retrying next 24-hour cycle/);
  daily(); assert.equal(children.length, 3);
  children[2].emit('close', 0);
  abort.abort();
  assert.equal(await running, 0);
  assert.ok(cancelled > 0);
  daily(); assert.equal(children.length, 3, 'no checks after agent exit');
});
test('private state refuses symlink credentials, sink and public-mode uploads', async t => {
  const f = fixture(t); await f.enroll();
  const secret = join(f.directory, 'secret-id');
  rmSync(secret); symlinkSync(join(f.home, 'outside'), secret);
  assert.equal(f.bao.status(), false);
  await assert.rejects(f.enroll(), /non-private\/non-regular/);
  assert.equal(existsSync(join(f.home, 'outside')), false);
  rmSync(secret); f.write(secret, f.oldSecret);
  symlinkSync(join(f.home, 'outside-token'), join(f.home, '.vault-token'));
  assert.throws(() => f.bao.config(), /token sink/);
  rmSync(join(f.home, '.vault-token'));
  f.write(f.upload, 'ciphertext'); chmodSync(f.upload, 0o644);
  await assert.rejects(f.bao.enroll(f.upload), /non-private enrollment upload/);
  assert.equal(existsSync(join(f.home, 'outside-token')), false);
});

for (const name of ['role-id', 'secret-id', 'metadata.json', 'agent.json', 'next-secret-id', 'rotation.json', 'retire.json', 'install.json']) {
  test(`enrollment preflights unsafe ${name} before any API call`, async t => {
    const f = fixture(t); await f.enroll(); f.calls.length = 0;
    const path = join(f.directory, name);
    rmSync(path, { force: true }); symlinkSync(join(f.home, 'outside'), path);
    await assert.rejects(f.enroll(), /non-private\/non-regular/);
    assert.deepEqual(f.calls, []);
  });
}
for (const [operation, name] of [
  ['rename', 'install.json'], ['rename', 'retire.json'], ['rename', 'role-id'],
  ['rename', 'secret-id'], ['rename', 'metadata.json'], ['rename', 'agent.json'],
  ['unlink', 'next-secret-id'], ['unlink', 'rotation.json'], ['unlink', 'install.json'],
]) {
  test(`enrollment interruption at ${operation} ${name} never retires the old identity; recovers forward`, async t => {
    const f = fixture(t); await f.enroll(); f.calls.length = 0;
    f.write(join(f.directory, 'next-secret-id'), 'fixture-staged-secret');
    f.write(join(f.directory, 'rotation.json'), JSON.stringify({ next: { secret_id_accessor: 'staged-accessor' }, old_accessor: 'old-accessor' }));
    f.failFS((op, path) => op === operation && path === join(f.directory, name));
    await assert.rejects(f.enroll(), /persistence failed.*no response logged/);
    assert.equal(f.calls.some(call => call.path.endsWith('/destroy')), false);
    assert.equal(f.calls.at(-1).path, 'auth/token/revoke-self');
    if (name === 'install.json' && operation === 'rename') {
      assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.oldSecret);
      assert.equal(f.bao.status(), true, 'old identity is still valid when journaling never began');
    } else {
      assert.equal(f.bao.status(), false, 'partial installation cannot claim enrolled');
      f.failFS(() => false);
      // A fresh process/controller has only the durable state, not closures.
      controller({ home: f.home, root: f.root, now: () => Date.parse('2026-01-01T00:00:00Z') }).config();
      assert.equal(f.bao.status(), true);
      assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), 'fixture-enrolled-secret-2');
      f.token();
      await f.bao.rotate();
      assert.deepEqual(f.calls.filter(call => call.path.endsWith('/destroy')).map(call => call.data.secret_id_accessor).sort(), ['old-accessor', 'staged-accessor']);
      assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), []);
    }
  });
}
test('published rotation old_accessor survives re-enrollment and a destroy outage, then daily retry', async t => {
  const f = fixture(t); await f.enroll(); f.advance(7); f.token();
  // Published-but-destroy-pending state from an interrupted rotation. Its old
  // accessor appears ONLY in the rotation journal, not metadata/retire.json.
  const next = { issued_at: Date.parse('2026-01-08T00:00:00Z'), secret_id_accessor: 'new-accessor' };
  f.write(join(f.directory, 'secret-id'), f.newSecret);
  f.write(join(f.directory, 'metadata.json'), JSON.stringify(next));
  f.write(join(f.directory, 'rotation.json'), JSON.stringify({ next, old_accessor: 'old-accessor' }));
  f.fail(path => path.endsWith('/destroy'));
  await f.enroll();
  assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')).sort(), ['new-accessor', 'old-accessor']);
  assert.equal(statSync(join(f.directory, 'retire.json')).mode & 0o777, 0o600);
  f.calls.length = 0;
  assert.deepEqual(await f.bao.rotate(), { rotated: false });
  assert.equal(f.calls.filter(call => call.path.endsWith('/destroy')).length, 2);
  assert.equal(f.calls.some(call => call.path.endsWith('/secret-id')), false);
  f.fail(() => false); f.calls.length = 0;
  assert.deepEqual(await f.bao.rotate(), { rotated: false });
  assert.deepEqual(f.calls.map(call => call.data.secret_id_accessor).sort(), ['new-accessor', 'old-accessor']);
  assert.ok(f.calls.every(call => call.token === 'fixture-current-token'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), []);
});
// OpenBao 2.7.1 answers destroy of an unknown accessor with 500; only a 404
// from the follow-up lookup proves the accessor is already gone.
for (const [lookup, gone] of [[404, true], [null, false], [500, false], [403, false], [undefined, false]]) {
  test(`retirement destroy failure with lookup ${lookup ?? 'found'} ${gone ? 'is gone' : 'remains pending'} and never touches the current accessor`, async t => {
    const f = fixture(t); await f.enroll(); f.token(); f.calls.length = 0;
    f.write(join(f.directory, 'retire.json'), JSON.stringify(['old-accessor', 'orphan-accessor']));
    f.fail(path => (path.endsWith('/destroy') && new RequestError(500)) || (path.endsWith('/lookup') && lookup !== null && new RequestError(lookup)));
    await f.bao.rotate();
    assert.deepEqual(f.calls.map(call => [call.path.split('/').at(-1), call.data.secret_id_accessor]), [['destroy', 'orphan-accessor'], ['lookup', 'orphan-accessor']]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), gone ? [] : ['orphan-accessor']);
  });
}
for (const name of ['next-secret-id', 'rotation.json']) {
  for (const outage of [false, true]) {
    test(`rotation compensates failed ${name} persistence; destroy outage=${outage}`, async t => {
      const f = fixture(t); await f.enroll(); f.advance(7); f.token(); f.calls.length = 0;
      f.failFS((operation, path) => operation === 'rename' && path === join(f.directory, name));
      f.fail(path => outage && path.endsWith('/destroy'));
      await assert.rejects(f.bao.rotate(), /staging failed.*no response logged/);
      // An outage fails the destroy and the confirming lookup, so retirement stays pending.
      assert.deepEqual(f.calls.map(call => call.path.split('/').at(-1)), outage ? ['secret-id', 'destroy', 'lookup'] : ['secret-id', 'destroy']);
      assert.equal(f.calls[1].data.secret_id_accessor, 'new-accessor');
      assert.equal(readFileSync(join(f.directory, 'secret-id'), 'utf8'), f.oldSecret);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'metadata.json'), 'utf8')).secret_id_accessor, 'old-accessor');
      assert.equal(existsSync(join(f.directory, 'rotation.json')), false);
      assert.equal(existsSync(join(f.directory, 'next-secret-id')), false);
      if (outage) {
        assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), ['new-accessor']);
        f.failFS(() => false); f.fail(() => false); f.calls.length = 0;
        // Make enrollment fresh to prove retry does not depend on rotation age.
        f.write(join(f.directory, 'metadata.json'), JSON.stringify({ secret_id_accessor: 'old-accessor', issued_at: Date.parse('2026-01-08T00:00:00Z') }));
        await f.bao.rotate();
        assert.deepEqual(f.calls.map(call => call.data.secret_id_accessor), ['new-accessor']);
        assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'retire.json'), 'utf8')), []);
      }
    });
  }
}
test('request preserves only safe HTTP status for retirement decisions', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('fixture-sensitive-body', { status: 400 });
  await assert.rejects(request('fixture-path', {}, 'fixture-token'), error => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'OpenBao request failed (no response logged)');
    assert.doesNotMatch(JSON.stringify(error), /fixture-sensitive-body|fixture-token/);
    return true;
  });
});

test('agent crashes relaunch with capped exponential backoff; daily rotation continues and long uptime resets it', async () => {
  const children = [], delays = [], messages = [];
  let daily, retry, clock = 0, cancelled = 0, cleared = 0;
  const launch = (_command, args) => {
    const child = new EventEmitter(); child.args = args;
    child.kill = signal => { child.killed = signal; child.emit('close', 0); };
    children.push(child); return child;
  };
  const abort = new AbortController();
  const running = serve({ launch, signal: abort.signal, now: () => clock,
    every: fn => { daily = fn; return 'daily'; }, cancel: () => cancelled++,
    later: (fn, ms) => { retry = fn; delays.push(ms); return 'retry'; }, clear: () => cleared++,
    log: message => messages.push(message),
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  children[1].emit('close', 0); await tick();
  for (let i = 0; i < 9; i++) {
    children.filter(child => child.args.includes('agent')).at(-1).emit('close', 1); await tick();
    if (i === 0) {
      daily();
      assert.deepEqual(children.at(-1).args, ['run', '--quiet', 'remote-agent-bao-rotate']);
      children.at(-1).emit('close', 0); await tick();
    }
    retry(); await tick();
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  clock += 10 * 60 * 1000;
  children.at(-1).emit('close', 1); await tick();
  assert.equal(delays.at(-1), 5000);
  assert.equal(cancelled, 0, 'daily timer survives every crash');
  abort.abort(); assert.equal(await running, 0);
  assert.equal(cancelled, 1); assert.equal(cleared, 1);
  const count = children.length; daily(); retry(); await tick();
  assert.equal(children.length, count, 'shutdown cancels any future launches');
  assert.ok(messages.every(message => /OpenBao agent exited; relaunching in/.test(message)));
});
test('shutdown terminates the agent and an in-flight rotation without scheduling a restart', async () => {
  const children = [], abort = new AbortController();
  let restarts = 0;
  const running = serve({ signal: abort.signal,
    launch: () => {
      const child = new EventEmitter();
      child.kill = signal => { child.killed = signal; child.emit('close', 0); };
      children.push(child); return child;
    }, every: () => 'timer', cancel: () => {}, later: () => restarts++,
  });
  abort.abort();
  assert.equal(await running, 0);
  assert.deepEqual(children.map(child => child.killed), ['SIGTERM', 'SIGTERM']);
  assert.equal(restarts, 0);
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`real service handles ${signal} and exits cleanly without leaving its agent`, { timeout: 10_000 }, async t => {
    const f = fixture(t);
    const bin = join(f.home, '.local/bin'); mkdirSync(bin, { recursive: true });
    const mise = join(bin, 'mise');
    const agentCode = `console.log("agent-ready"); process.on("SIGTERM",()=>{console.log("agent-stopped");process.exit(0)}); setInterval(()=>{},1000);`;
    writeFileSync(mise, `#!/bin/sh\nif [ "$1" = exec ]; then exec '${process.execPath}' -e '${agentCode}'; fi\nexit 0\n`, { mode: 0o700 });
    const child = spawn(process.execPath, [new URL('../services/bao-service.mjs', import.meta.url).pathname], {
      env: { HOME: f.home, PATH: process.env.PATH }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const closed = once(child, 'close');
    while (!output.includes('agent-ready')) await once(child.stdout, 'data');
    child.kill(signal);
    const [code] = await closed;
    assert.equal(code, 0);
    assert.match(output, /agent-stopped/);
  });
}


test('box state root is the persistent Bootstrap root that enroll.ts uploads into, not HOME', async () => {
  const { root } = await import('../services/processes.mjs');
  assert.equal(root, '/workspace/home/.remote-agent');
  assert.equal(controller({ home: '/home/boxuser' }).directory, join(root, 'bao'));
  assert.match(readFileSync(new URL('../infra/enroll.ts', import.meta.url), 'utf8'), /\/workspace\/home\/\.remote-agent\/bao-enroll-/);
});
