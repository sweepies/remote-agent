import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';

export const root = '/workspace/home/.remote-agent';
export const services = ['t3', 'tailscaled', 'relay', 'bao'];
export function atomicJSON(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
export function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
export function processRecord(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return { pid, group: Number(fields[2]), start: fields[19] };
  } catch { return undefined; }
}
export function live(name) {
  const saved = readJSON(`${root}/services/${name}.json`);
  const observed = saved && processRecord(saved.pid);
  return observed && observed.start === saved.start && observed.group === saved.pid ? observed : undefined;
}
export function start(name) {
  if (!services.includes(name)) throw new Error('Unknown service');
  mkdirSync(`${root}/services`, { recursive: true, mode: 0o700 });
  if (live(name)) return;
  const saved = readJSON(`${root}/services/${name}.json`);
  if (saved && groupExists(saved.pid)) throw new Error('Recorded service group still exists without its leader; stop the group before relaunch');
  const child = spawn(`${process.env.HOME}/.local/bin/remote-agent-${name}`, [], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}
export function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
// Never infer group death from leader death: descendants may still hold locks.
export async function stopGroup(record, {
  exists = groupExists, signal = (pid, value) => process.kill(pid, value),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 100,
} = {}) {
  const send = value => {
    try { signal(-record.pid, value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const gone = async () => {
    for (let i = 0; i < attempts; i++) {
      if (!exists(record.pid)) return true;
      await sleep(100);
    }
    return !exists(record.pid);
  };
  send('SIGTERM');
  if (await gone()) return;
  // Only this recorded process group is eligible for escalation.
  send('SIGKILL');
  if (!(await gone())) throw new Error('Service process group survived SIGKILL; refusing relaunch');
}
export async function stop(name) {
  const record = readJSON(`${root}/services/${name}.json`);
  if (!record) return;
  const observed = processRecord(record.pid);
  if (observed && (observed.start !== record.start || observed.group !== record.pid)) {
    throw new Error('Service process identity changed; refusing to stop an unrelated group');
  }
  // A dead leader can still have a live, recorded descendant group.
  await stopGroup(record);
}
