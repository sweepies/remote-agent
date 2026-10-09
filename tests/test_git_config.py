"""Offline Git-bootstrap boundary tests with synthetic HOME and stub tools."""

import os
import stat
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = tomllib.loads((ROOT / "mise.toml").read_text())
STOCK_CONFIG = (
    "[user]\n\temail = box@upstash.com\n\tname = Upstash Box\n"
    "[credential]\n\thelper = store\n[safe]\n\tdirectory = *\n"
)


class GitConfigBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-git-config-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.bin = Path(self.temp.name) / "bin"
        self.bin.mkdir()
        self.config = self.home / ".gitconfig"
        self.calls = self.home / "calls"
        self.hooks = self.home / "dotfiles/.config/git/hooks"
        self.hooks.mkdir(parents=True)
        self.hooks.chmod(0o555)
        # Allowlist the environment: no real credentials, HOME, or Git config.
        self.env = {
            "HOME": str(self.home), "PATH": f"{self.bin}:{os.environ['PATH']}",
            "CALL_LOG": str(self.calls),
            "DOTFILES_PIN": (ROOT / "dotfiles.lock").read_text().strip(),
        }
        self.executable("uname", '#!/bin/sh\nprintf "Linux\\n"\n')
        self.executable("git", '''#!/bin/sh
case "$3" in
    rev-parse) printf '%s\\n' "$DOTFILES_PIN" ;;
    status) printf '%s' "${DOTFILES_STATUS:-}" ;;
    *) exit 1 ;;
esac
''')
        self.executable("mise", '''#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
exit "${BOOTSTRAP_EXIT:-0}"
''')

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def bootstrap(self):
        # Run the actual remote task through its handoff to dotfiles. The shared
        # migration itself is tested in dotfiles; fnox enrollment is unrelated.
        task, separator, _ = CONFIG["tasks"]["bootstrap"]["run"].partition('\ncd "$HOME"\n')
        self.assertTrue(separator)
        self.assertTrue(task.endswith('mise -C "$HOME/dotfiles" bootstrap --yes'))
        return subprocess.run(["sh", "-c", task], cwd=ROOT, env=self.env,
                              capture_output=True, text=True, timeout=10)

    def assert_bootstrapped(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"-C {self.home}/dotfiles bootstrap --yes", self.calls.read_text())
        self.assertEqual(stat.S_IMODE(self.hooks.stat().st_mode), 0o555)

    def test_only_known_stock_config_is_removed(self):
        self.config.write_text(STOCK_CONFIG)
        self.assert_bootstrapped(self.bootstrap())
        self.assertFalse(self.config.exists())
        self.assert_bootstrapped(self.bootstrap())
        self.assertFalse(self.config.exists())

    def test_local_config_and_helper_survive_repeated_bootstrap(self):
        content = (
            '[include]\n\tpath = ~/.config/git/shared.gitconfig\n'
            '[user]\n\temail = local@example.invalid\n'
            '[credential "https://github.com"]\n\thelper =\n'
            '\thelper = !fixture-gh auth git-credential\n'
        )
        self.config.write_text(content)
        self.config.chmod(0o600)
        for _ in range(2):
            self.assert_bootstrapped(self.bootstrap())
            self.assertEqual(self.config.read_text(), content)
            self.assertFalse(self.config.is_symlink())
            self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)

    def test_modified_stock_config_is_preserved(self):
        content = STOCK_CONFIG + '[alias]\n\ts = status\n'
        self.config.write_text(content)
        self.assert_bootstrapped(self.bootstrap())
        self.assertEqual(self.config.read_text(), content)

    def test_symlinks_are_left_for_shared_migration_to_validate(self):
        for name, exists in (("dotfiles/.gitconfig", True),
                             ("unexpected.gitconfig", True),
                             ("missing.gitconfig", False)):
            with self.subTest(name=name):
                target = self.home / name
                if exists:
                    target.write_text(STOCK_CONFIG)
                self.config.symlink_to(target)
                self.assert_bootstrapped(self.bootstrap())
                self.assertTrue(self.config.is_symlink())
                self.assertEqual(self.config.readlink(), target)
                if exists:
                    self.assertEqual(target.read_text(), STOCK_CONFIG)
                self.config.unlink()

    def test_nonregular_config_is_left_for_shared_migration_to_reject(self):
        self.config.mkdir()
        self.assert_bootstrapped(self.bootstrap())
        self.assertTrue(self.config.is_dir())

    def test_dirty_dotfiles_aborts_before_touching_config_or_hooks(self):
        self.config.write_text(STOCK_CONFIG)
        self.env["DOTFILES_STATUS"] = " M .gitconfig\n"
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing modified dotfiles", result.stderr)
        self.assertEqual(self.config.read_text(), STOCK_CONFIG)
        self.assertFalse(self.calls.exists())
        self.assertEqual(stat.S_IMODE(self.hooks.stat().st_mode), 0o555)

    def test_pin_mismatch_aborts_before_touching_config(self):
        self.config.write_text(STOCK_CONFIG)
        self.env["DOTFILES_PIN"] = "0" * 40
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match dotfiles.lock", result.stderr)
        self.assertEqual(self.config.read_text(), STOCK_CONFIG)
        self.assertFalse(self.calls.exists())

    def test_shared_migration_failure_preserves_local_config_and_relocks_hooks(self):
        content = '[user]\n\temail = local@example.invalid\n'
        self.config.write_text(content)
        self.env["BOOTSTRAP_EXIT"] = "1"
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), content)
        self.assertEqual(stat.S_IMODE(self.hooks.stat().st_mode), 0o555)


if __name__ == "__main__":
    unittest.main()
