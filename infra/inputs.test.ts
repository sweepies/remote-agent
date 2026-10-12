import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changedServices } from "./Bootstrap.ts";

test("Box-wide environment drift fingerprints every service; SOCKS5 drift only fingerprints Tailscale", () => {
  const directory = mkdtempSync(join(tmpdir(), "remote-agent-inputs-"));
  const root = resolve(import.meta.dir, "..");
  try {
    for (const path of ["mise.toml", "remote-tools.toml", "dotfiles.lock", "scripts", "services", "relay"]) cpSync(join(root, path), join(directory, path), { recursive: true });
    const fingerprints = () => {
      const result = Bun.spawnSync([process.execPath, "-e", `import {serviceFingerprints} from ${JSON.stringify(join(root, "infra/inputs.ts"))}; console.log(JSON.stringify(serviceFingerprints()));`], { cwd: directory });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    const initial = fingerprints(), config = join(directory, "remote-tools.toml");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, original.replace('MISE_ENV = "agent"', 'MISE_ENV = "other"'));
    expect(changedServices(initial, fingerprints())).toEqual(["t3", "tailscaled", "relay", "bao"]);
    writeFileSync(config, original);
    const daemon = join(directory, "scripts/tailscale-daemon.sh");
    writeFileSync(daemon, readFileSync(daemon, "utf8").replace("--socks5-server=127.0.0.1:1055", "--socks5-server=127.0.0.1:1056"));
    expect(changedServices(initial, fingerprints())).toEqual(["tailscaled"]);
  } finally { rmSync(directory, { recursive: true }); }
});
