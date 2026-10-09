"""Offline Bao CLI/mise wrapper tests. Only synthetic HOME and stub commands."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = tomllib.loads((ROOT / "mise.toml").read_text())
REMOTE = tomllib.loads((ROOT / "remote-tools.toml").read_text())


class BaoTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-bao-tasks-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.bin = self.home / "bin"
        self.bin.mkdir(mode=0o700)
        self.env = {key: value for key, value in os.environ.items()
                    if not any(word in key for word in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "AGE_KEY"))
                    and not key.startswith(("FNOX_", "OP_", "MISE_", "XDG_"))}
        self.env.update(HOME=str(self.home), PATH=f"{self.bin}:{os.environ['PATH']}",
                        CALL_LOG=str(self.home / "calls"))

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def body(self, name):
        # The Box state root is fixed on the persistent disk; tests relocate it.
        return REMOTE["tasks"][name]["run"].replace("/workspace/home/.remote-agent", str(self.home / ".remote-agent"))

    def task(self, action, *args):
        return subprocess.run(["sh", "-c", self.body(f"remote-agent-bao-{action}"), action, *args],
                              cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=10)

    def test_box_tasks_forward_only_public_paths_and_serialize_writers(self):
        self.executable("flock", '#!/bin/sh\nprintf "lock %s\\n" "$*" >> "$CALL_LOG"\n')
        self.executable("node", '''#!/bin/sh
printf 'node %s cwd=%s\n' "$*" "$PWD" >> "$CALL_LOG"
case "$*" in *' enroll '*) printf '{"role":"agent-remote-agent","secret_id_accessor":"fixture-accessor","expires_at":"2026-01-31T00:00:00Z"}\n';; esac
''')
        upload = str(self.home / ".remote-agent/bao-enroll-1234.age")
        for action, args in (("enroll", (upload,)), ("rotate", ()), ("config", ())):
            result = self.task(action, *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            if action == "enroll":
                self.assertEqual(json.loads(result.stdout)["secret_id_accessor"], "fixture-accessor")
        calls = (self.home / "calls").read_text()
        self.assertEqual(calls.count("lock 8"), 3)
        self.assertIn("bao.mjs enroll " + upload, calls)
        self.assertIn("bao.mjs rotate", calls)
        self.assertIn("bao.mjs config", calls)
        self.assertIn('start("bao")', calls)
        self.assertEqual(stat.S_IMODE((self.home / ".remote-agent").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.home / ".remote-agent/bao-enrollment.lock").stat().st_mode), 0o600)
        self.assertNotEqual(self.task("enroll").returncode, 0)

    def test_actual_mise_quiet_invocation_forwards_upload_as_first_script_argument(self):
        mise = shutil.which("mise")
        self.assertIsNotNone(mise)
        assert mise is not None
        config = self.home / ".config/mise"
        config.mkdir(parents=True)
        # Only real Bao task definitions: no tools, plugins, hooks or credential
        # configuration. Running from synthetic HOME excludes repository config.
        tasks = []
        for action in ("enroll", "status"):
            name = f"remote-agent-bao-{action}"
            tasks.append(f"[tasks.{name}]\nrun = {json.dumps(self.body(name))}\n")
        (config / "config.toml").write_text("\n".join(tasks))
        self.env.update(MISE_CONFIG_DIR=str(config), MISE_DATA_DIR=str(self.home / "mise-data"),
                        MISE_CACHE_DIR=str(self.home / "mise-cache"), MISE_OFFLINE="true",
                        MISE_AUTO_INSTALL="false", MISE_TRUSTED_CONFIG_PATHS=str(self.home))
        self.executable("flock", "#!/bin/sh\nexit 0\n")
        self.executable("bao", "#!/bin/sh\nexit 99\n")
        self.executable("node", '''#!/bin/sh
case "$2" in
 enroll)
  [ "$#" = 3 ] || exit 91
  [ "$3" = "$EXPECTED_UPLOAD" ] || exit 92
  printf 'upload=%s argc=%s\\n' "$3" "$#" >> "$CALL_LOG"
  printf 'mise WARN fixture enrollment warning\\n' >&2
  printf '{"role":"agent-remote-agent","secret_id_accessor":"fixture-accessor","expires_at":"2026-01-31T00:00:00Z"}\\n'
  ;;
 status)
  printf 'mise WARN fixture status warning\\n' >&2
  printf '{"enrolled":true}\\n'
  ;;
 *) printf 'fixture service-start output\\n';;
esac
''')
        # Spaces and shell metacharacters must remain a single argument; only a
        # public path is passed to mise. The fake rejects omitted/extra args.
        upload = str(self.home / ".remote-agent/bao-enroll-path with spaces;literal.age")
        self.env["EXPECTED_UPLOAD"] = upload
        for action, args in (("enroll", (upload,)), ("status", ())):
            result = subprocess.run([mise, "run", "--quiet", f"remote-agent-bao-{action}", "--", *args],
                                    cwd=self.home, env=self.env, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout)
            lines = result.stdout.strip().splitlines()
            status = json.loads(lines[-1])
            self.assertIn("mise WARN", result.stdout)
            if action == "enroll":
                self.assertEqual(status["secret_id_accessor"], "fixture-accessor")
                self.assertIn("fixture service-start output", result.stdout)
            else:
                self.assertEqual(status, {"enrolled": True})
        self.assertEqual((self.home / "calls").read_text(), f"upload={upload} argc=3\n")

    def test_human_cli_uses_default_helper_and_sanitizes_failures(self):
        bun = shutil.which("bun")
        assert bun is not None
        self.executable("bao", '''#!/bin/sh
[ -z "${BAO_TOKEN:-}" ] && [ -z "${VAULT_TOKEN:-}" ] || exit 99
[ "$BAO_ADDR" = https://bao.maccrae.family ] || exit 98
printf '%s\n' "$*" >> "$CALL_LOG"
if [ "$1" = write ]; then cat >> "$CALL_LOG"; exit 0; fi
printf 'fixture-sensitive-error' >&2
exit 1
''')
        self.env.update(BAO_TOKEN="fixture-stale-override", VAULT_TOKEN="fixture-stale-override")
        code = ('import {bao,ROLE_SETTINGS} from ' + json.dumps(str(ROOT / "infra/enroll.ts")) + ';'
                'await bao(["write","-format=json","auth/approle/role/agent-remote-agent","-"],ROLE_SETTINGS);'
                'try {await bao(["read","-format=json","auth/approle/role/agent-remote-agent/role-id"]);} '
                'catch(error) {console.log(error.message);}')
        result = subprocess.run([bun, "-e", code], cwd=ROOT, env=self.env, text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("operator's bao OIDC session", result.stdout)
        self.assertNotIn("fixture-sensitive-error", result.stdout + result.stderr)
        calls = (self.home / "calls").read_text()
        self.assertIn('"token_policies":["admin"]', calls)
        self.assertIn('"secret_id_ttl":"720h"', calls)
        self.assertNotIn("fixture-stale-override", calls)

    def test_ci_enrollment_fails_before_any_provider_operation(self):
        self.env["CI"] = "true"
        bun = shutil.which("bun")
        assert bun is not None
        result = subprocess.run([bun, str(ROOT / "infra/enroll.ts")], cwd=ROOT,
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("human-only and cannot run in CI", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse((self.home / "calls").exists())

    def test_pins_and_service_contract(self):
        self.assertEqual(LOCAL["tools"]["openbao"], "2.7.1")
        self.assertEqual(REMOTE["tools"]["openbao"], "2.7.1")
        self.assertEqual(REMOTE["env"]["BAO_ADDR"], "https://bao.maccrae.family")
        self.assertEqual(LOCAL["tasks"]["agent:enroll"]["run"], "bun run infra/enroll.ts")
        for path in [ROOT / "scripts/bao-agent.sh"]:
            result = subprocess.run(["sh", "-n", str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
