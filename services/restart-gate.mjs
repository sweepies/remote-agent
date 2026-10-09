import { readdirSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { root, live, start, stop, atomicJSON, readJSON } from './processes.mjs';

// Internal T3 schema: re-verify this query whenever npm:t3 changes.
export const BUSY_SQL = `SELECT
 (SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting') OR (status='queued' AND coalesce(json_extract(payload_json,'$.queueHeld'),0) <> 1))
 +(SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending')
 +(SELECT count(*) FROM scheduled_tasks WHERE last_run_status='running') AS busy;`;
export function busy(open = () => new DatabaseSync('/workspace/home/.t3/userdata/statev2.sqlite', { readOnly: true })) {
  let database;
  try {
    database = open();
    return database.prepare(BUSY_SQL).get().busy !== 0;
  } catch { return true; } finally { database?.close(); }
}
export function requests() {
  mkdirSync(`${root}/restarts`, { recursive: true, mode: 0o700 });
  return readdirSync(`${root}/restarts`).filter(p => /^[a-f0-9]{64}\.json$/.test(p))
    .map(file => ({ file: `${root}/restarts/${file}`, data: readJSON(`${root}/restarts/${file}`) }))
    .filter(({ data }) => data?.status === 'pending').sort((a, b) => a.data.created - b.data.created);
}
export function resumed(request, service) {
  return (service ? [service] : request.services).every(name => {
    const current = live(name);
    return current && JSON.stringify(current) !== JSON.stringify(request.baseline[name]);
  });
}
export function finish(file, request, status) {
  atomicJSON(file, { ...request, status });
  if (status === 'done') atomicJSON(`${root}/applied.json`, { fingerprints: request.fingerprints, hash: request.hash });
}
export async function waitForRestarts({
  isBusy = busy, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  list = requests, hasResumed = resumed, complete = finish, halt = stop, launch = start,
} = {}) {
  let idle = 0;
  while (true) {
    const pending = list();
    if (!pending.length) return;
    if (isBusy()) idle = 0; else idle++;
    for (const { file, data } of pending) {
      const recordCompletion = () => {
        data.completed ??= {};
        let changed = false;
        for (const name of data.services) {
          if (!data.completed[name] && hasResumed(data, name)) {
            data.completed[name] = true;
            changed = true;
          }
        }
        if (changed) complete(file, data, 'pending');
        return data.services.every(name => data.completed[name]);
      };
      if (recordCompletion()) { complete(file, data, 'done'); continue; }
      if (now() - data.created >= 24 * 60 * 60 * 1000) { complete(file, data, 'abandoned'); continue; }
      if (idle < 2) continue;
      for (const name of data.services) {
        if (data.completed[name]) continue;
        await halt(name);
        launch(name);
        // Persist each successful service independently before touching another.
        await sleep(1000);
        recordCompletion();
      }
      if (recordCompletion()) complete(file, data, 'done');
    }
    await sleep(30_000);
  }
}
if (import.meta.main || process.argv[1] === new URL(import.meta.url).pathname) await waitForRestarts();
