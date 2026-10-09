import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { plugin } from "bun";
import ts from "typescript";

// Offline only: no plan/deploy, input functions, credential files, or stack effects.
const root = resolve(import.meta.dir, "..");
const text = (path: string) => readFileSync(resolve(root, path), "utf8");
const json = (path: string) => {
  try {
    return JSON.parse(text(path));
  } catch (cause) {
    throw new Error(`Cannot parse required JSON: ${path}`, { cause });
  }
};
const source = (path: string) => ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true);
const pins = {
  alchemy: "2.0.0-beta.81",
  effect: "4.0.2",
  "@effect/platform-bun": "4.0.2",
  "@effect/platform-node": "4.0.2",
};
const pkg = json("package.json");
const lockResult = ts.parseConfigFileTextToJson("bun.lock", text("bun.lock"));
assert.equal(lockResult.error, undefined, "bun.lock must parse");
const lock = lockResult.config;
for (const [name, version] of Object.entries(pins)) {
  assert.equal(pkg.dependencies[name], version, `package.json pin: ${name}`);
  assert.equal(lock.workspaces[""].dependencies[name], version, `bun.lock pin: ${name}`);
  assert.equal(lock.packages[name][0], `${name}@${version}`, `resolved pin: ${name}`);
  assert.equal(json(`node_modules/${name}/package.json`).version, version, `installed pin: ${name}`);
}
assert.ok(pkg.scripts.test.includes("node --test tests/services.node.mjs"), "Node service suite must run");

// Parse contracts rather than grepping text: comments/quoted keys cannot fake them.
const mise = Bun.TOML.parse(text("mise.toml")) as {
  tools: Record<string, string>;
  bootstrap: { files: Record<string, { source: string; mode: string }> };
  dotfiles: Record<string, { source: string; mode: string }>;
  tasks: Record<string, { run: string }>;
};
const tools = Bun.TOML.parse(text("remote-tools.toml")) as {
  tools: Record<string, string | { version: string; os: string[] }>;
  env: Record<string, unknown>;
};
assert.equal(mise.tools.bun, "1.4.2");
assert.equal(mise.tools.node, "24.14.0");
assert.equal(mise.tools.python, "3.14.3");
assert.equal(mise.tools.openbao, "2.7.1");
assert.equal(tools.tools.openbao, "2.7.1");
assert.equal(tools.env.BAO_ADDR, "https://bao.maccrae.family");
assert.equal(mise.tasks["agent:enroll"].run, "bun run infra/enroll.ts");
assert.equal(tools.tools["npm:t3"], "0.0.46-nightly.20261007.2774");
assert.deepEqual(tools.tools["aqua:tailscale/tailscale"], { version: "1.102.5", os: ["linux"] });
assert.equal(tools.env.FNOX_AGE_KEY, false);
assert.equal(tools.env.FNOX_AGE_KEY_FILE, false);
assert.deepEqual(mise.dotfiles["~/.config/mise/conf.d/remote-agent.toml"], { source: "remote-tools.toml", mode: "copy" });
for (const [name, script] of Object.entries({
  t3: "t3-serve.sh", start: "box-start.sh", relay: "relay-serve.sh", tailscaled: "tailscale-daemon.sh", bao: "bao-agent.sh",
})) {
  assert.deepEqual(mise.bootstrap.files[`~/.local/bin/remote-agent-${name}`], { source: `scripts/${script}`, mode: "0755" });
}
assert.equal(mise.tasks.check.run, "bun run check");
assert.equal(mise.tasks.test.run, "bun run test");
assert.match(text("dotfiles.lock"), /^[a-f0-9]{40}\n$/, "dotfiles.lock must be one exact commit");
const workflow = Bun.YAML.parse(text(".github/workflows/deploy.yml")) as {
  on: { push: { branches: string[] }; workflow_dispatch: unknown };
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: Record<string, { needs?: string; uses?: string; with?: Record<string, string>; secrets?: string; steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>;
};
assert.deepEqual(workflow.on.push.branches, ["main"]);
assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
assert.deepEqual(workflow.concurrency, { group: "deploy", "cancel-in-progress": false });
assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
const deploy = workflow.jobs.deploy;
assert.deepEqual(Object.keys(workflow.jobs), ["deploy"], "no caller-side token jobs or artifacts");
assert.equal(deploy.uses, "sweepies/ops-workflows/.github/workflows/alchemy-deploy.yml@bb139d8b60817a0874305b2475f12850c2d775a9");
assert.equal(deploy.secrets, "inherit");
assert.deepEqual(deploy.with, {
  deployment_profile: "bun", bao_jwt_role: "remote-agent-deploy",
  bao_secret_path: "kv/remote-agent-deploy", cloudflare_role: "remote-agent-deploy",
});

function literalConstant(path: string, name: string): string {
  for (const statement of source(path).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer && ts.isStringLiteral(declaration.initializer)) return declaration.initializer.text;
    }
  }
  throw new Error(`Missing literal constant ${path}:${name}`);
}
assert.equal(literalConstant("infra/Bootstrap.ts", "MISE_VERSION"), "2026.10.4");
assert.equal(literalConstant("infra/Bootstrap.ts", "MISE_ARM64_SHA256"), "9013ce1d7d9bbbf65254cda178562f5450c474a705907c18b77e6b678bb10041");
assert.equal(literalConstant("alchemy.run.ts", "GATEWAY_HOST"), "agent.ops.sweepy.dev");

// Exact external boundaries, NOT blanket package/external or Effect aliases.
// cloudflare:* are runtime-provided built-ins. Vite is the runtime package's
// optional DEV peer; unavailable offline, and never used by deploy/import checks.
// Report it explicitly; this check does not claim Vite dev mode is functional.
const runtime = json("node_modules/@alchemy.run/cloudflare-runtime/package.json");
assert.ok(runtime.peerDependenciesMeta?.vite?.optional, "Vite external must remain an optional development peer");
console.warn("Offline stack bundle retains cloudflare:* runtime built-ins and optional Vite dev peer; Vite dev mode is not validated.");
for (const [entrypoint, target, external] of [
  ["gateway/worker.mjs", "browser", []],
  ["alchemy.run.ts", "bun", ["cloudflare:*", "vite"]],
] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, entrypoint)], target, external: [...external] });
  if (!result.success) throw new AggregateError(result.logs, `Offline bundle failed: ${entrypoint}`);
  assert.ok(result.outputs.length > 0 && result.outputs.every(output => output.size > 0));
  console.log(`Offline bundle: ${entrypoint} (${result.outputs.reduce((n, output) => n + output.size, 0)} bytes)`);
}

// Import the stack's *unchanged* dependencies with Bun's production conditions,
// but omit its one top-level Alchemy.Stack expression. Even constructing that
// expression calls providers/state; the generator body also reads credentials.
// This onLoad hook is scoped to this one application file only. It does not
// rewrite/alias any dependency, and the unmodified stack was bundled above.
const stackPath = resolve(root, "alchemy.run.ts");
const stackText = text("alchemy.run.ts");
const stackTree = source("alchemy.run.ts");
const assignments = stackTree.statements.filter(ts.isExportAssignment);
assert.equal(assignments.length, 1, "stack must have exactly one default expression");
const assignment = assignments[0];
assert.ok(ts.isCallExpression(assignment.expression) && assignment.expression.expression.getText(stackTree) === "Alchemy.Stack", "expected Alchemy.Stack expression");
for (const statement of stackTree.statements) {
  if (ts.isImportDeclaration(statement) || statement === assignment) continue;
  assert.ok(ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 && statement.declarationList.declarations.every(d => d.initializer && ts.isStringLiteral(d.initializer)), "refusing executable stack top-level statements during offline import");
}
const safeStack = stackText.slice(0, assignment.getStart(stackTree)) + "export default undefined;" + stackText.slice(assignment.end);
plugin({
  name: "offline-stack-construction-guard",
  setup(build) {
    build.onLoad({ filter: /alchemy\.run\.ts$/ }, ({ path }) => {
      assert.equal(resolve(path), stackPath, "guard must affect only the application stack");
      return { contents: safeStack, loader: "ts" };
    });
  },
});
try {
  const stack = await import(stackPath);
  assert.equal(stack.default, undefined, "stack construction must not execute");
  assert.equal(stack.GATEWAY_HOST, "agent.ops.sweepy.dev");
} finally {
  plugin.clearAll();
}
console.log("Offline stack imports passed without construction, resource execution, input evaluation, or credential reads.");
