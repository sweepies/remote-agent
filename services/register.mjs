import { root, processRecord, atomicJSON, services } from './processes.mjs';
const [name, value] = process.argv.slice(2);
const record = processRecord(Number(value));
if (!services.includes(name) || !record || record.group !== record.pid) throw new Error('Launch services in a dedicated process group (setsid)');
atomicJSON(`${root}/services/${name}.json`, record);
