import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { busy, BUSY_SQL, waitForRestarts } from '../services/restart-gate.mjs';
import { atomicJSON, readJSON, processRecord, stopGroup, groupExists } from '../services/processes.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function fixture({ observations = [false, false], elapsed = 0, alreadyResumed = false, names = ['relay'] } = {}) {
  const data = { created: 0, services: names, status: 'pending' };
  let pending = true, clock = elapsed;
  const restarted = new Set(alreadyResumed ? names : []);
  const actions = [], sleeps = [], statuses = [];
  const options = {
    list: () => pending ? [{ file: 'fake-marker', data }] : [],
    isBusy: () => observations.shift() ?? false,
    hasResumed: (_data, name) => restarted.has(name),
    now: () => clock,
    halt: async name => { actions.push(`stop:${name}`); },
    launch: name => { actions.push(`start:${name}`); restarted.add(name); },
    complete: (_file, _request, status) => { if (status !== 'pending') { statuses.push(status); pending = false; } },
    sleep: async ms => { sleeps.push(ms); clock += ms; },
  };
  return { options, actions, sleeps, statuses };
}
test('busy schema includes queued unheld work, pending runtime requests and running scheduled tasks', () => {
  assert.match(BUSY_SQL, /coalesce\(json_extract\(payload_json,'\$\.queueHeld'\),0\) <> 1/);
  assert.match(BUSY_SQL, /status='pending'/);
  assert.match(BUSY_SQL, /last_run_status='running'/);
  assert.equal(busy(), true, 'missing database fails closed');
});
test('busy SQL counts active/unheld queues and fails closed on malformed schema/payload', () => {
  function database(runs = [], runtime = [], scheduled = []) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE orchestration_v2_projection_runs (status TEXT,payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_runtime_requests (status TEXT);
      CREATE TABLE scheduled_tasks (last_run_status TEXT);`);
    for (const [status, payload] of runs) db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?)').run(status, payload);
    for (const status of runtime) db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?)').run(status);
    for (const status of scheduled) db.prepare('INSERT INTO scheduled_tasks VALUES (?)').run(status);
    return db;
  }
  assert.equal(busy(() => database()), false);
  for (const status of ['preparing', 'starting', 'running', 'waiting', 'queued']) assert.equal(busy(() => database([[status, '{}']])), true);
  assert.equal(busy(() => database([['queued', '{"queueHeld":1}'], ['done', '{}']])), false);
  assert.equal(busy(() => database([['queued', '{"queueHeld":false}']])), true);
  assert.equal(busy(() => database([], ['pending'])), true);
  assert.equal(busy(() => database([], [], ['running'])), true);
  assert.equal(busy(() => database([['queued', 'invalid JSON']])), true);
  assert.equal(busy(() => new DatabaseSync(':memory:')), true);
});
test('two consecutive idle samples restart only named services', async () => {
  const f = fixture({ names: ['relay', 't3'] });
  await waitForRestarts(f.options);
  assert.deepEqual(f.actions, ['stop:relay', 'start:relay', 'stop:t3', 'start:t3']);
  assert.deepEqual(f.statuses, ['done']);
  assert.equal(f.sleeps[0], 30_000);
});
test('a busy result resets the idle streak', async () => {
  const f = fixture({ observations: [false, true, false, false] });
  await waitForRestarts(f.options);
  assert.equal(f.sleeps.filter(ms => ms === 30_000).length, 4);
  assert.deepEqual(f.statuses, ['done']);
});
test('24-hour busy deadline abandons without stopping a service', async () => {
  const f = fixture({ observations: [true], elapsed: 24 * 60 * 60 * 1000 });
  await waitForRestarts(f.options);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.statuses, ['abandoned']);
});
test('fresh process identities after pause satisfy pending restart even when busy', async () => {
  const f = fixture({ observations: [true], alreadyResumed: true });
  await waitForRestarts(f.options);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.statuses, ['done']);
});
test('partial completion survives waiter restarts; relay failure never repeats successful T3 restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'restart-progress-'));
  const file = join(directory, 'request.json');
  const actions = [];
  let relayStarts = 0, t3Started = false;
  try {
    atomicJSON(file, { created: 0, status: 'pending', services: ['t3', 'relay'], baseline: { t3: 'old-t3', relay: 'old-relay' } });
    const options = {
      list: () => { const data = readJSON(file); return data.status === 'pending' ? [{ file, data }] : []; },
      isBusy: () => false, now: () => 0,
      hasResumed: (data, name) => name === 't3' ? t3Started && data.baseline.t3 === 'old-t3' : relayStarts >= 3,
      halt: async name => actions.push(`stop:${name}`),
      launch: name => { actions.push(`start:${name}`); if (name === 't3') t3Started = true; else relayStarts++; },
      complete: (path, data, status) => atomicJSON(path, { ...data, status }),
      sleep: async ms => { if (ms === 30_000 && relayStarts === 2) throw new Error('waiter interrupted'); },
    };
    await assert.rejects(waitForRestarts(options), /waiter interrupted/);
    assert.deepEqual(readJSON(file).completed, { t3: true });
    // Even if T3 is subsequently absent, persisted completion prevents another restart.
    t3Started = false;
    await waitForRestarts({ ...options, sleep: async () => {} });
    assert.equal(readJSON(file).status, 'done');
    assert.equal(actions.filter(a => a === 'start:t3').length, 1);
    assert.equal(actions.filter(a => a === 'start:relay').length, 3);
  } finally { rmSync(directory, { recursive: true }); }
});
test('whole-group stop waits and escalates even after the leader is gone', async () => {
  let descendant = true, leader = true;
  const signals = [];
  await stopGroup({ pid: 123 }, {
    attempts: 2, sleep: async () => {}, exists: () => leader || descendant,
    signal: (pid, value) => { assert.equal(pid, -123); signals.push(value); if (value === 'SIGTERM') leader = false; else descendant = false; },
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(descendant, false);
  await assert.rejects(stopGroup({ pid: 123 }, { attempts: 1, sleep: async () => {}, exists: () => true, signal: () => {} }), /refusing relaunch/);
});
test('real child outliving its group leader is killed before stop resolves', { timeout: 10_000 }, async () => {
  // The child ignores TERM and holds the leader process group alive.
  const childCode = `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);`;
  const leader = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>console.log('ready'));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(leader.stdout, 'data');
    const exit = once(leader, 'exit');
    process.kill(-leader.pid, 'SIGTERM');
    await exit;
    assert.equal(groupExists(leader.pid), true, 'descendant still holds the group after leader exits');
    await stopGroup({ pid: leader.pid }, { attempts: 10 });
    assert.equal(groupExists(leader.pid), false);
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
});
test('atomic private markers and missing process records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-agent-test-'));
  try {
    const path = join(directory, 'result.json');
    assert.equal(readJSON(path), undefined);
    atomicJSON(path, { status: 'pending' });
    assert.deepEqual(readJSON(path), { status: 'pending' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(processRecord(999999999), undefined);
  } finally { rmSync(directory, { recursive: true }); }
});
test('launchers use narrow recorded process groups and lifetime locks, not pkill', () => {
  const processSource = readFileSync(new URL('../services/processes.mjs', import.meta.url), 'utf8');
  assert.match(processSource, /signal\(-record\.pid, value\)/);
  assert.match(processSource, /send\('SIGTERM'\)/);
  assert.match(processSource, /observed\.start === saved\.start/);
  assert.doesNotMatch(processSource, /pkill|killall/);
  for (const file of ['t3-serve.sh', 'tailscale-daemon.sh', 'relay-serve.sh', 'bao-agent.sh']) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    assert.match(source, /flock -n 9/); assert.match(source, /services\/register\.mjs/);
  }
});
