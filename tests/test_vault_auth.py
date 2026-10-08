"""Persistent vault auth tests with real fnox/age and an offline op stub.

Synthetic fixture credentials only. No network, SSH, or real HOME writes.
"""

import json
import os
import secrets
import shutil
import stat
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TASKS = tomllib.loads((ROOT / "remote-tools.toml").read_text())["tasks"]


class VaultAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mise = shutil.which("mise")
        cls.fnox = subprocess.check_output(["mise", "which", "fnox"], text=True).strip()
        cls.age = subprocess.check_output(["mise", "which", "age-keygen"], text=True).strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-vault-auth-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.directory = self.home / ".config/fnox"
        self.directory.mkdir(parents=True, mode=0o700)
        self.config = self.directory / "config.toml"
        self.identity = self.directory / "age.txt"
        self.token = secrets.token_urlsafe(24)
        self.env = {key: value for key, value in os.environ.items()
                    if not any(word in key for word in
                               ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "AGE_KEY"))
                    and not key.startswith(("FNOX_", "OP_", "MISE_", "XDG_", "GIT_"))}
        self.env.update(HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / ".config"),
                        PATH=f"{self.bin}:{os.environ['PATH']}", OP_CALL_LOG=str(self.home / "op-calls"),
                        FNOX_NO_COLOR="1", FNOX_NON_INTERACTIVE="1", FIXTURE_AUTH_EXPECTED=self.token)
        subprocess.run([self.age, "-o", str(self.identity)], env=self.env,
                       capture_output=True, check=True)
        self.identity.chmod(0o600)
        recipient = subprocess.check_output([self.age, "-y", str(self.identity)],
                                            env=self.env, text=True).strip()
        self.config.write_text('import = ["./shared.toml"]\n\n[providers.sync-age]\n'
                               'type = "age"\nrecipients = ["' + recipient + '"]\n'
                               'key_file = "~/.config/fnox/age.txt"\n')
        self.config.chmod(0o600)
        (self.directory / "shared.toml").write_text('''[providers.op]
type = "1password"
vault = "dev"
[secrets]
DEFAULT_SECRET = { provider = "op", value = "op://dev/default/credential" }
[profiles.git-signing.secrets]
GIT_SSH_SIGNING_KEY = { provider = "op", value = "op://dev/signing/private key", env = false }
''')
        (self.bin / "fnox").symlink_to(self.fnox)
        self.executable("op", '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
# Fail without printing the supplied credential.
if os.environ.get('OP_SERVICE_ACCOUNT_TOKEN') != os.environ['FIXTURE_AUTH_EXPECTED']:
    sys.exit(97)
if os.environ.get('FNOX_OP_SERVICE_ACCOUNT_TOKEN'):
    sys.exit(98)
with Path(os.environ['OP_CALL_LOG']).open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if 'read' in sys.argv[1:]:
    print('mock-private-key' if any('/signing/' in arg for arg in sys.argv) else 'cached-default')
elif '--version' in sys.argv[1:]:
    print('2.40.0')
else:
    # This tests forwarding without performing live read/write operations.
    payload = sys.stdin.read()
    print(json.dumps({'args':sys.argv[1:], 'stdin':payload, 'cwd':os.getcwd(),
                      'default_present':'DEFAULT_SECRET' in os.environ}))
    sys.exit(int(os.environ.get('OP_EXIT_CODE', '0')))
''')
        self.executable("ssh-keygen", "#!/bin/sh\nexit 0\n")

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def command(self, *args, input="", check=True):
        result = subprocess.run(args, env=self.env, cwd=self.home, input=input,
                                capture_output=True, text=True, timeout=30)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def store_token(self):
        result = self.command(self.fnox, "--config", str(self.config), "--no-daemon",
                              "--profile", "op-auth", "set", "OP_SERVICE_ACCOUNT_TOKEN",
                              "--provider", "sync-age", "--global", input=self.token + "\n")
        self.assertNotIn(self.token, result.stdout + result.stderr)
        self.config.chmod(0o600)

    def task(self, name, *args, input="", check=True):
        return self.command("sh", "-c", TASKS[name]["run"], name, *args, input=input, check=check)

    def test_native_persistence_encryption_and_private_profile(self):
        self.store_token()
        contents = self.config.read_text()
        self.assertNotIn(self.token, contents)
        config = tomllib.loads(contents)
        secret = config["profiles"]["op-auth"]["secrets"]["OP_SERVICE_ACCOUNT_TOKEN"]
        self.assertEqual(secret["provider"], "sync-age")
        self.assertNotIn("OP_SERVICE_ACCOUNT_TOKEN", config.get("secrets", {}))
        for path in (self.config, self.identity):
            self.assertFalse(path.is_symlink())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for _ in range(2):
            self.assertEqual(self.task("remote-agent-vault", "op", "--version").stdout.strip(), "2.40.0")

    def test_auth_profile_excludes_default_secret_and_stale_overrides(self):
        self.store_token()
        stale = secrets.token_urlsafe(24)
        self.env.update(OP_SERVICE_ACCOUNT_TOKEN=stale, FNOX_OP_SERVICE_ACCOUNT_TOKEN=stale,
                        FNOX_AGE_KEY="invalid", FNOX_AGE_KEY_FILE="/missing", REMOTE_AGE_KEY="invalid",
                        FNOX_PROFILE="git-signing")
        result = self.task("remote-agent-vault", "op", "item", "list", "--vault", "dev")
        self.assertFalse(json.loads(result.stdout)["default_present"])

    def test_forwards_read_write_args_stdin_cwd_and_exit_status(self):
        self.store_token()
        for operation in ("get", "edit", "create"):
            args = ["item", operation, "example item", "--vault", "dev"]
            response = json.loads(self.task("remote-agent-vault", "op", *args, input="fixture-json\n").stdout)
            self.assertEqual(response["args"], args)
            self.assertEqual(response["stdin"], "fixture-json\n")
            self.assertEqual(Path(response["cwd"]).resolve(), self.home.resolve())
        self.env["OP_EXIT_CODE"] = "23"
        self.assertEqual(self.task("remote-agent-vault", "op", "item", "list", check=False).returncode, 23)

    def test_missing_auth_fails_before_vault_command(self):
        result = self.task("remote-agent-vault", "op", "--version", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / "op-calls").exists())

    def test_default_environment_uses_cache_not_service_token(self):
        self.store_token()
        self.task("remote-agent-enroll")
        probe = "import os,sys; sys.exit(0 if os.getenv('DEFAULT_SECRET') == 'cached-default' and 'OP_SERVICE_ACCOUNT_TOKEN' not in os.environ else 9)"
        self.command(self.fnox, "--config", str(self.config), "--no-daemon", "--profile", "default",
                     "--if-missing", "error", "exec", "--", "python3", "-c", probe)

    def test_enrollment_refreshes_using_saved_token_in_fresh_processes(self):
        self.store_token()
        stale = secrets.token_urlsafe(24)
        self.env.update(OP_SERVICE_ACCOUNT_TOKEN=stale, FNOX_OP_SERVICE_ACCOUNT_TOKEN=stale)
        for _ in range(2):
            self.task("remote-agent-enroll")
        self.assertEqual((self.home / ".ssh/git-signing").read_text().strip(), "mock-private-key")
        self.assertEqual(stat.S_IMODE((self.home / ".ssh/git-signing").stat().st_mode), 0o600)
        calls = (self.home / "op-calls").read_text()
        self.assertGreaterEqual(calls.count("/default/"), 2)
        self.assertGreaterEqual(calls.count("/signing/"), 2)
        self.assertNotIn(self.token, self.config.read_text() + calls)

    def test_native_mise_task_forwards_arguments_stdin_and_current_directory(self):
        self.store_token()
        body = TASKS["remote-agent-vault"]["run"]
        (self.home / "mise.toml").write_text('[tasks.remote-agent-vault]\ndir = "{{cwd}}"\nrun = \'\'\'\n' + body + "\n'''\n")
        self.env.update(MISE_TRUSTED_CONFIG_PATHS=str(self.home), MISE_DATA_DIR=str(self.home / ".local/share/mise"),
                        MISE_CONFIG_DIR=str(self.home / ".config/mise"))
        args = ["item", "edit", "example item", "--vault", "dev"]
        response = json.loads(self.command(self.mise, "run", "remote-agent-vault", "--", "op", *args,
                                           input="fixture-json\n").stdout)
        self.assertEqual(response["args"], args)
        self.assertEqual(response["stdin"], "fixture-json\n")
        self.assertEqual(Path(response["cwd"]).resolve(), self.home.resolve())

    def test_auth_task_requires_terminal_without_writing_config(self):
        original = self.config.read_bytes()
        result = self.task("remote-agent-auth", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("interactive SSH terminal", result.stderr)
        self.assertEqual(self.config.read_bytes(), original)
        self.assertIn("set OP_SERVICE_ACCOUNT_TOKEN --provider sync-age --global", TASKS["remote-agent-auth"]["run"])


if __name__ == "__main__":
    unittest.main()
