import { start, live, services } from './processes.mjs';
import { requests, resumed, finish } from './restart-gate.mjs';

for (const name of services) start(name);
await new Promise(r => setTimeout(r, 1000));
for (let i = 0; i < 100 && !services.every(live); i++) await new Promise(r => setTimeout(r, 100));
if (!services.every(live)) throw new Error('Service launch failed; inspect private service logs');
// Pause kills every process. Fresh process identities satisfy queued restarts
// without executing a stale waiter or waiting for a database that is not open yet.
for (const { file, data } of requests()) if (resumed(data)) finish(file, data, 'done');
