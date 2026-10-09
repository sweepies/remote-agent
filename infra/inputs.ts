import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sha256, type ServiceFingerprints } from "./Bootstrap.ts";

export const BOX_LABEL = "remote-agent";

export function commitPin(env: { CI?: string; GITHUB_SHA?: string } = { CI: Bun.env.CI, GITHUB_SHA: Bun.env.GITHUB_SHA }): string {
  if (env.CI === "true") {
    const commit = env.GITHUB_SHA;
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("CI requires a 40-hex GITHUB_SHA");
    return commit;
  }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Refusing local deployment from a dirty tree; commit inputs first");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
export function dotfilesPin(): string {
  const pin = readFileSync("dotfiles.lock", "utf8");
  if (!/^[a-f0-9]{40}\n$/.test(pin)) throw new Error("dotfiles.lock must contain one 40-hex SHA and newline");
  return pin.trim();
}
export function serviceFingerprints(): ServiceFingerprints {
  const config = Bun.TOML.parse(readFileSync("remote-tools.toml", "utf8")) as { tools: Record<string, unknown>; env: Record<string, unknown>; tasks: Record<string, { run: string }> };
  const local = Bun.TOML.parse(readFileSync("mise.toml", "utf8")) as { tools: Record<string, unknown> };
  const common = ["services/processes.mjs", "services/register.mjs", "scripts/box-start.sh", "services/init.mjs"].map(path => readFileSync(path, "utf8"));
  const fingerprint = (paths: string[], version: unknown) => sha256(JSON.stringify([local.tools.node, config.tools.node, ...common, version, ...paths.map(path => readFileSync(path, "utf8"))]));
  return {
    t3: fingerprint(["scripts/t3-serve.sh"], config.tools["npm:t3"]),
    tailscaled: fingerprint(["scripts/tailscale-daemon.sh"], config.tools["aqua:tailscale/tailscale"]),
    relay: fingerprint(["scripts/relay-serve.sh", "relay/server.mjs"], local.tools.node),
    bao: fingerprint(["scripts/bao-agent.sh", "services/bao.mjs", "services/bao-address.mjs", "services/bao-service.mjs"], {
      version: config.tools.openbao,
      tasks: ["enroll", "rotate", "config", "status"].map(name => config.tasks[`remote-agent-bao-${name}`].run),
    }),
  };
}
