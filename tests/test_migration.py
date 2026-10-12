"""Offline regression tests: no SSH, real credentials, or home-directory writes."""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]
CONFIG = tomllib.loads((ROOT / "mise.toml").read_text())
REMOTE = tomllib.loads((ROOT / "remote-tools.toml").read_text())


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.bin = Path(self.temp.name) / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:{os.environ['PATH']}")
        # Never expose harness credentials to mocks/subprocesses.
        for key in list(self.env):
            if any(word in key for word in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "AGE_KEY")):
                self.env.pop(key)
        self.env.update(UPSTASH_BOX_API_KEY="mock-password", CALL_LOG=str(self.home / "calls"))

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)
        return path

    def run_shell(self, content):
        return subprocess.run(["sh", "-c", content], cwd=ROOT, env=self.env,
                              capture_output=True, text=True)

    def mock_bootstrap_tools(self):
        # Resolve tools before changing HOME so mise's real home is never touched.
        age = subprocess.check_output(["mise", "which", "age-keygen"], text=True).strip()
        python = subprocess.check_output(["mise", "which", "python"], text=True).strip()
        self.executable("age-keygen", f'#!/bin/sh\nexec "{age}" "$@"\n')
        self.executable("python", f'#!/bin/sh\nexec "{python}" "$@"\n')
        pin = (ROOT / "dotfiles.lock").read_text().strip()
        self.executable("git", '#!/bin/sh\ncase "$*" in *rev-parse*) printf "' + pin + '\\n";; esac\n')
        self.executable("uname", '#!/bin/sh\nprintf "Linux\\n"\n')
        self.executable("mise", '''#!/bin/sh
printf '%s\n' "$*" >> "$CALL_LOG"
case "$1" in
    exec) shift; if [ "$1" = -- ]; then shift; fi
          if [ "$1" = pi ]; then exit 0; fi
          exec "$@" ;;
    *) exit 0 ;;
esac
''')

    def test_native_config_contract(self):
        self.assertEqual(CONFIG["min_version"], "2026.10.3")
        self.assertNotIn("repos", CONFIG["bootstrap"])
        self.assertNotIn("remote", CONFIG["bootstrap"])
        updater = CONFIG["tasks"]["bootstrap"]["run"]
        self.assertIn("dotfiles.lock", updater)
        self.assertNotIn("repos update", updater)
        self.assertIn("trap relock EXIT", updater)
        self.assertIn("mise trust", CONFIG["bootstrap"]["hooks"]["pre-dotfiles"]["run"])
        self.assertNotIn("secrets", CONFIG["bootstrap"])
        self.assertEqual(CONFIG["bootstrap"]["mise_shell_activate"], {"bashrc": "activate"})
        self.assertEqual(CONFIG["dotfiles"]["~/.bashrc/local-bin"], {"line": 'PATH="$HOME/.local/bin:$PATH"', "position": "prepend"})
        self.assertEqual(CONFIG["tools"]["bun"], "1.4.2")
        self.assertNotIn("bootstrap-remote", CONFIG["tasks"])
        self.assertNotIn("ssh", CONFIG["tasks"])
        self.assertNotIn("remote-agent-auth", REMOTE["tasks"])
        self.assertEqual(set(CONFIG["dotfiles"]), {
            "~/.pi/agent/mcp.json", "~/.pi/agent/skills",
            "~/.config/mise/conf.d/remote-agent.toml", "~/.bashrc/local-bin", "~/.bashrc/mise-shims", "~/.bashrc/mise-env"})
        self.assertFalse((ROOT / "scripts/box-bootstrap.sh").exists())
        self.assertEqual(set(REMOTE["tools"]), {
            "go", "node", "openbao", "op", "npm:t3", "aqua:tailscale/tailscale"})
        self.assertEqual(REMOTE["tools"]["node"], CONFIG["tools"]["node"])
        self.assertEqual(REMOTE["tools"]["go"], "1.26.1")
        self.assertEqual(REMOTE["tools"]["op"]["version"], "2.40.0")
        self.assertEqual(REMOTE["tools"]["npm:t3"], "0.0.46-nightly.20261007.2774")
        self.assertIs(REMOTE["env"]["FNOX_AGE_KEY"], False)
        self.assertEqual(REMOTE["env"]["MISE_ENV"], "agent")
        self.assertEqual(REMOTE["tools"]["op"]["os"], ["linux"])

    def test_box_environment_reaches_login_shells_and_service_sessions(self):
        mise = shutil.which("mise")
        self.assertIsNotNone(mise)
        config = self.home / ".config/mise"
        (config / "conf.d").mkdir(parents=True)
        # Only the shipped environment contract; no tools, hooks or secrets.
        (config / "conf.d/remote-agent.toml").write_text(
            '[env]\nMISE_ENV = "' + REMOTE["env"]["MISE_ENV"] + '"\n')
        for key in list(self.env):
            if key.startswith(("MISE_", "XDG_", "FNOX_", "OP_")):
                self.env.pop(key)
        self.env.update(MISE_CONFIG_DIR=str(config), MISE_DATA_DIR=str(self.home / ".local/share/mise"),
                        MISE_CACHE_DIR=str(self.home / "mise-cache"), MISE_OFFLINE="true",
                        MISE_AUTO_INSTALL="false", MISE_TRUSTED_CONFIG_PATHS=str(self.home))
        local = self.home / ".local/bin"
        local.mkdir(parents=True)
        (local / "mise").symlink_to(mise)
        (config / "config.toml").write_text('[tasks.remote-agent-bao-config]\nrun = \'[ "$MISE_ENV" = agent ]\'\n')
        entry = CONFIG["dotfiles"]["~/.bashrc/mise-env"]
        self.assertEqual(entry["position"], "prepend")
        self.assertEqual(entry["line"], 'eval "$("$HOME/.local/bin/mise" env --shell bash)"')
        prefix = "\n".join(CONFIG["dotfiles"][f"~/.bashrc/{name}"]["line"] for name in ("mise-env", "local-bin", "mise-shims"))
        (self.home / ".bashrc").write_text(prefix + '\ncase $- in *i*) ;; *) return;; esac\n')
        (self.home / ".bash_profile").write_text('. "$HOME/.bashrc"\n')
        infra = self.home / "private-infra"
        infra.mkdir()
        (infra / "mise.toml").write_text('[env]\nKUBECONFIG = "human-kubeconfig"\n')
        (infra / "mise.agent.toml").write_text('[env]\nKUBECONFIG = "agent-kubeconfig"\n')
        target = self.executable("kubectl", '#!/bin/sh\n[ "$MISE_ENV" = agent ] && [ "$KUBECONFIG" = agent-kubeconfig ]\n')
        (local / "kubectl").symlink_to(target)
        shims = self.home / ".local/share/mise/shims"
        shims.mkdir(parents=True)
        # Use the native shim dispatcher, not a simulated kubectl prefix.
        (shims / "kubectl").symlink_to(mise)
        probe = '[ "$MISE_ENV" = agent ] && kubectl get nodes && bash -c \'[ "$MISE_ENV" = agent ]\''
        for args in (["bash", "-lc", probe], ["bash", "--noprofile", "--rcfile", str(self.home / ".bashrc"), "-ic", probe]):
            result = subprocess.run(args, cwd=infra, env=self.env, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.executable("flock", "#!/bin/sh\nexit 0\n")
        self.executable("node", '#!/bin/sh\n[ "$MISE_ENV" = agent ] || exit 91\n')
        self.executable("t3", '#!/bin/sh\n[ "$MISE_ENV" = agent ] || exit 92\nbash -c \'[ "$MISE_ENV" = agent ]\'\n')
        self.executable("tailscaled", '#!/bin/sh\n[ "$MISE_ENV" = agent ] || exit 93\nprintf "%s\\n" "$*" > "$CALL_LOG"\n')
        # Execute the real launchers, relocating only their persistent state root.
        for name in ("box-start.sh", "t3-serve.sh", "relay-serve.sh", "tailscale-daemon.sh", "bao-agent.sh"):
            source = (ROOT / "scripts" / name).read_text().replace("/workspace/home", str(self.home))
            (self.home / "remote-agent").mkdir(exist_ok=True)
            result = subprocess.run(["sh", "-c", source], cwd=self.home, env=self.env,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--socks5-server=127.0.0.1:1055", (self.home / "calls").read_text())

    def test_fresh_identity_repeat_and_rebuilt_machine(self):
        self.mock_bootstrap_tools()
        task = CONFIG["tasks"]["bootstrap"]["run"]
        first = self.run_shell(task)
        self.assertEqual(first.returncode, 0, first.stderr)
        directory = self.home / ".config/fnox"
        config, identity = directory / "config.toml", directory / "age.txt"
        original = (config.read_bytes(), identity.read_bytes())
        parsed = tomllib.loads(config.read_text())
        self.assertEqual(parsed["import"], ["./shared.toml"])
        self.assertEqual(parsed["providers"]["sync-age"]["key_file"], "~/.config/fnox/age.txt")
        self.assertEqual(len(parsed["providers"]["sync-age"]["recipients"]), 1)
        for file in (config, identity):
            self.assertFalse(file.is_symlink())
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        repeat = self.run_shell(task)
        self.assertEqual(repeat.returncode, 0, repeat.stderr)
        self.assertEqual(original, (config.read_bytes(), identity.read_bytes()))
        shutil.rmtree(directory)
        rebuilt = self.run_shell(task)
        self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
        self.assertNotEqual(original[1], identity.read_bytes())
        self.assertNotIn("exec -- fnox ", (self.home / "calls").read_text())

    def test_partial_and_legacy_state_are_not_overwritten(self):
        self.mock_bootstrap_tools()
        directory = self.home / ".config/fnox"
        directory.mkdir(parents=True)
        identity = directory / "age.txt"
        identity.write_text("legacy identity sentinel")
        result = self.run_shell(CONFIG["tasks"]["bootstrap"]["run"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing partial/non-regular", result.stderr)
        self.assertEqual(identity.read_text(), "legacy identity sentinel")
        identity.unlink()
        self.assertEqual(self.run_shell(CONFIG["tasks"]["bootstrap"]["run"]).returncode, 0)
        config = directory / "config.toml"
        config.write_text('default_provider = "old-age"\n')
        original = identity.read_bytes()
        result = self.run_shell(CONFIG["tasks"]["bootstrap"]["run"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing legacy/mismatched", result.stderr)
        self.assertEqual(config.read_text(), 'default_provider = "old-age"\n')
        self.assertEqual(identity.read_bytes(), original)

    def mock_enrollment_tools(self):
        directory = self.home / ".config/fnox"
        directory.mkdir(parents=True)
        (directory / "config.toml").write_text('import = ["./shared.toml"]\n')
        self.executable("fnox", '''#!/bin/sh
printf '%s\n' "$*" >> "$CALL_LOG"
case " $* " in
    *' get GIT_SSH_SIGNING_KEY '*)
        if [ "${FAIL_EXPORT:-}" = 1 ]; then printf partial; exit 1; fi
        printf mock-private-key ;;
esac
''')
        self.executable("ssh-keygen", '#!/bin/sh\nexit "${FAIL_VALIDATE:-0}"\n')

    def test_enrollment_no_clobber_and_private_key_permissions(self):
        self.mock_enrollment_tools()
        task = REMOTE["tasks"]["remote-agent-enroll"]["run"]
        result = self.run_shell(task)
        self.assertEqual(result.returncode, 0, result.stderr)
        key = self.home / ".ssh/git-signing"
        self.assertEqual(key.read_text(), "mock-private-key")
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        key.write_text("existing-key")
        self.assertEqual(self.run_shell(task).returncode, 0)
        self.assertEqual(key.read_text(), "existing-key")
        calls = (self.home / "calls").read_text()
        self.assertIn("--profile git-signing --no-defaults sync", calls)
        self.assertEqual(calls.count(" get GIT_SSH_SIGNING_KEY"), 1)
        self.assertEqual(list((self.home / ".ssh").glob(".git-signing.*")), [])

    def test_failed_export_or_validation_leaves_no_destination(self):
        self.mock_enrollment_tools()
        task = REMOTE["tasks"]["remote-agent-enroll"]["run"]
        for variable in ("FAIL_EXPORT", "FAIL_VALIDATE"):
            with self.subTest(variable=variable):
                self.env[variable] = "1"
                self.assertNotEqual(self.run_shell(task).returncode, 0)
                self.env.pop(variable)
                self.assertFalse((self.home / ".ssh/git-signing").exists())
                self.assertEqual(list((self.home / ".ssh").glob(".git-signing.*")), [])

    def test_cutover_service_contract(self):
        self.assertRegex((ROOT / "dotfiles.lock").read_text(), r"^[a-f0-9]{40}\n$")
        self.assertIn("--host 127.0.0.1", (ROOT / "scripts/t3-serve.sh").read_text())
        daemon = (ROOT / "scripts/tailscale-daemon.sh").read_text()
        self.assertIn("--tun=userspace-networking", daemon)
        self.assertIn("--socks5-server=127.0.0.1:1055", daemon)
        self.assertEqual(daemon.count("--socks5-server="), 1)
        for name in ("t3-serve.sh", "tailscale-daemon.sh", "relay-serve.sh", "bao-agent.sh"):
            launcher = (ROOT / "scripts" / name).read_text()
            self.assertIn("flock -n 9", launcher)
            self.assertIn("services/register.mjs", launcher)


if __name__ == "__main__":
    unittest.main()
