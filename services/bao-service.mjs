import { spawn } from 'node:child_process';
import { day } from './bao.mjs';
import { root } from './processes.mjs';
import { fileURLToPath } from 'node:url';

export async function serve({ launch = spawn, every = setInterval, cancel = clearInterval,
  later = setTimeout, clear = clearTimeout, now = Date.now, signal,
  log = message => console.error(message),
} = {}) {
  const mise = `${process.env.HOME}/.local/bin/mise`;
  let agent, rotation, rotationChild, retry, wake, closing = false;
  function rotate() {
    if (closing || rotation) return;
    rotation = new Promise(resolve => {
      let finished = false;
      const finish = code => {
        if (finished) return;
        finished = true;
        if (code !== 0 && !closing) log('OpenBao rotation failed; retrying next 24-hour cycle.');
        resolve();
      };
      try {
        rotationChild = launch(mise, ['run', '--quiet', 'remote-agent-bao-rotate'], { stdio: 'inherit' });
        rotationChild.once('error', () => finish(1));
        rotationChild.once('close', finish);
      } catch { finish(1); }
    }).finally(() => { rotation = undefined; rotationChild = undefined; });
  }
  const timer = every(rotate, day);
  const stop = () => {
    if (closing) return;
    closing = true;
    cancel(timer);
    if (retry !== undefined) clear(retry);
    wake?.();
    agent?.kill('SIGTERM');
    rotationChild?.kill('SIGTERM');
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let backoff = 5000, first = true;
  try {
    while (!closing) {
      const started = now();
      await new Promise(resolve => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          agent = undefined;
          resolve();
        };
        try {
          agent = launch(mise, ['exec', '--', 'bao', 'agent', `-config=${root}/bao/agent.json`], { stdio: 'inherit' });
          agent.once('error', finish);
          agent.once('close', finish);
        } catch { finish(); }
        if (first) { first = false; rotate(); }
      });
      if (closing) break;
      if (now() - started >= 10 * 60 * 1000) backoff = 5000;
      log(`OpenBao agent exited; relaunching in ${backoff / 1000}s (no response logged)`);
      await new Promise(resolve => { wake = resolve; retry = later(resolve, backoff); });
      retry = undefined; wake = undefined;
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
    }
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
    await rotation;
  }
  return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  process.once('SIGHUP', () => abort.abort());
  process.exitCode = await serve({ signal: abort.signal });
}
