#!/usr/bin/env python3
"""stdlib-only unittest suite for the git-hook step of installer.py.

Uses a synthetic Pack (a copy of the real guard.sh as its git_hooks_source) and
throw-away repositories under a temp dir, in the hermetic git environment from
test_git_hooks.GitSandbox (empty global config, temp HOME, ceiling at the temp
root). The installer is called in-process, so installer.main's git calls are
hermetic too. Nothing here touches a real repository or any real git config.
"""

import contextlib
import errno
import hashlib
import io
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

_TESTS = Path(__file__).resolve().parent
for _p in (str(_TESTS), str(_TESTS.parent)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import installer  # noqa: E402
import install  # noqa: E402
from installer import Pack  # noqa: E402
from test_git_hooks import GUARD, HOOK_NAMES, GitSandbox  # noqa: E402

OLD_OURS = b"#!/bin/sh\n# claude-engineering:guard v0\necho old guard\n"
FOREIGN = b"#!/bin/sh\necho someone else's hook\n"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class GitHooksInstallerBase(GitSandbox):
    def setUp(self) -> None:
        super().setUp()
        self.src = self.root / "src"
        (self.src / "rules").mkdir(parents=True)
        (self.src / "rules" / "a.md").write_text("rule a\n")
        (self.src / "git-hooks").mkdir()
        (self.src / "git-hooks" / "guard.sh").write_bytes(GUARD.read_bytes())
        self.pack = self.make_pack()
        self.proj = self.root / "proj"
        self.proj.mkdir()
        self.init_repo(self.proj)

    def make_pack(self, **kw) -> Pack:
        args = dict(name="claude-engineering", kind="project", repo_root=self.src, managed_paths=["rules"],
                    git_hooks_source="git-hooks/guard.sh")
        args.update(kw)
        return Pack(**args)

    def init_repo(self, path: Path) -> None:
        r = self.run_git("init", "-q", "-b", "main", cwd=path)
        self.assertEqual(r.returncode, 0, r.stderr)

    @property
    def hooks(self) -> Path:
        return self.proj / ".git" / "hooks"

    def run_cli(self, action, *extra, project=None, pack=None):
        out, err = io.StringIO(), io.StringIO()
        argv = [action, "--project", str(project or self.proj), *extra]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = installer.main(pack or self.pack, argv)
        return code, out.getvalue(), err.getvalue()

    def snapshot(self, root=None):
        """{path: (sha256 or link target, mode)} of every file and symlink under root."""
        snap = {}
        for dirpath, _dirs, files in os.walk(root or self.root):
            for f in files:
                p = Path(dirpath) / f
                if p.is_symlink():
                    snap[p] = ("->" + os.readlink(p), None)
                else:
                    snap[p] = (_sha(p), stat.S_IMODE(p.stat().st_mode))
        return snap

    def changed_paths(self, before, after):
        return {p for p in set(before) | set(after) if before.get(p) != after.get(p)}

    def assertOurHooks(self, hooks_dir=None):
        for name in HOOK_NAMES:
            p = (hooks_dir or self.hooks) / name
            self.assertFalse(p.is_symlink(), name)
            self.assertEqual(p.read_bytes(), GUARD.read_bytes(), name)
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o755, name)


class InstallTest(GitHooksInstallerBase):
    def test_fresh_install_copies_real_executable_files(self):
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertOurHooks()
        self.assertEqual(out.count("[NEW]"), 1 + 3)  # plan heading for rules/a.md + the three hooks
        self.assertTrue((self.proj / ".claude" / "rules" / "a.md").exists())

    def test_git_hooks_dir_is_never_copied_into_dot_claude(self):
        self.run_cli("install")
        self.assertFalse((self.proj / ".claude" / "git-hooks").exists())
        manifest = (self.proj / ".claude" / ".claude-engineering.manifest.json").read_text()
        self.assertNotIn("git-hooks", manifest)
        self.assertNotIn(".git/hooks", manifest)
        managed = installer.discover_managed_files(install.PACK)
        self.assertEqual([rel for rel in managed if rel.startswith("git-hooks")], [])

    def test_real_pack_declares_the_source_outside_managed_paths(self):
        self.assertEqual(install.PACK.git_hooks_source, "git-hooks/guard.sh")
        self.assertNotIn("git-hooks", install.PACK.managed_paths)
        self.assertTrue((install.PACK.repo_root / install.PACK.git_hooks_source).is_file())

    def test_second_run_is_a_noop(self):
        self.run_cli("install")
        before = {n: (self.hooks / n).stat().st_mtime_ns for n in HOOK_NAMES}
        code, out, err = self.run_cli("update")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertEqual(out.count("[UNCHANGED]"), 1 + 3)  # rules/a.md + three hooks
        self.assertEqual({n: (self.hooks / n).stat().st_mtime_ns for n in HOOK_NAMES}, before)

    def test_stale_copy_with_our_marker_is_updated(self):
        self.hooks.mkdir(exist_ok=True)
        for n in HOOK_NAMES:
            (self.hooks / n).write_bytes(OLD_OURS)
            (self.hooks / n).chmod(0o755)
        code, out, err = self.run_cli("update")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertEqual(out.count("[UPDATE]"), 3)
        self.assertOurHooks()

    def test_new_version_of_the_script_replaces_ours(self):
        self.run_cli("install")
        v2 = GUARD.read_text().replace("guard v1", "guard v2")
        (self.src / "git-hooks" / "guard.sh").write_text(v2)
        code, out, err = self.run_cli("update")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        for n in HOOK_NAMES:
            self.assertEqual((self.hooks / n).read_text(), v2)

    def test_lost_exec_bit_is_repaired(self):
        self.run_cli("install")
        (self.hooks / "pre-push").chmod(0o644)  # git would silently ignore it
        code, out, err = self.run_cli("update")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertEqual(out.count("[UPDATE]"), 1)
        self.assertOurHooks()

    def test_missing_hooks_dir_is_created_inside_the_git_dir(self):
        shutil.rmtree(self.hooks)
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertOurHooks()

    def test_foreign_hook_is_never_overwritten_not_even_with_force(self):
        self.hooks.mkdir(exist_ok=True)
        (self.hooks / "pre-push").write_bytes(FOREIGN)
        (self.hooks / "pre-push").chmod(0o755)
        for extra in ((), ("--force",)):
            with self.subTest(extra=extra):
                code, out, err = self.run_cli("install", *extra)
                self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
                self.assertEqual((self.hooks / "pre-push").read_bytes(), FOREIGN)
                self.assertEqual((self.hooks / "pre-commit").read_bytes(), GUARD.read_bytes())  # the rest landed
                self.assertEqual((self.hooks / "pre-merge-commit").read_bytes(), GUARD.read_bytes())
                self.assertTrue((self.proj / ".claude" / "rules" / "a.md").exists())  # managed copy applied
                self.assertIn("CONFLICT", err)
                self.assertIn("pre-push", err)
                self.assertIn("NOT active", err)
                self.assertTrue(err.rstrip().splitlines()[-1].startswith("  - "), "summary comes last")

    def test_symlink_at_a_hook_path_is_foreign_and_never_written_through(self):
        outside = self.root / "outside-guard.sh"
        outside.write_bytes(GUARD.read_bytes())  # even a link to a file that carries our marker
        self.hooks.mkdir(exist_ok=True)
        (self.hooks / "pre-commit").symlink_to(outside)
        (self.hooks / "pre-merge-commit").symlink_to(self.root / "does-not-exist")  # dangling
        code, out, err = self.run_cli("install", "--force")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        self.assertTrue((self.hooks / "pre-commit").is_symlink())
        self.assertTrue((self.hooks / "pre-merge-commit").is_symlink())
        self.assertEqual(outside.read_bytes(), GUARD.read_bytes())
        self.assertFalse((self.root / "does-not-exist").exists())

    def test_symlinked_hooks_dir_is_foreign(self):
        shared = self.root / "shared-hooks"
        shared.mkdir()
        shutil.rmtree(self.hooks)
        self.hooks.symlink_to(shared)
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        self.assertEqual(list(shared.iterdir()), [])

    def test_local_core_hookspath_is_skipped_with_a_warning(self):
        self.run_git("config", "core.hooksPath", ".husky", cwd=self.proj)
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        for n in HOOK_NAMES:
            self.assertFalse((self.hooks / n).exists(), n)
        for needle in ("core.hooksPath", ".husky", "NOT active"):
            self.assertIn(needle, err)
        self.assertTrue((self.proj / ".claude" / "rules" / "a.md").exists())

    def test_global_core_hookspath_is_skipped_too(self):
        # the temp GIT_CONFIG_GLOBAL file is the only "global" config git reads here
        (self.root / "gitconfig").write_text("[core]\n\thooksPath = /nonexistent/shared-hooks\n")
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        self.assertIn("/nonexistent/shared-hooks", err)
        self.assertFalse((self.hooks / "pre-commit").exists())

    def test_linked_worktree_installs_into_the_common_git_dir(self):
        r = self.run_git("commit", "--allow-empty", "-q", "-m", "x", cwd=self.proj)
        self.assertEqual(r.returncode, 0, r.stderr)
        wt = self.root / "wt"
        r = self.run_git("worktree", "add", "-q", "-b", "feat", str(wt), cwd=self.proj)
        self.assertEqual(r.returncode, 0, r.stderr)
        before = self.snapshot()
        code, out, err = self.run_cli("install", project=wt)
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertOurHooks(self.proj / ".git" / "hooks")
        self.assertFalse((self.proj / ".git" / "worktrees" / "wt" / "hooks").exists())
        self.assertTrue((wt / ".claude" / "rules" / "a.md").exists())
        after = self.snapshot()
        for p in self.changed_paths(before, after):
            self.assertTrue(wt / ".claude" in p.parents or p.parent == self.proj / ".git" / "hooks", p)

    def test_not_a_git_repository_is_skipped_quietly(self):
        plain = self.root / "plain"
        plain.mkdir()
        code, out, err = self.run_cli("install", project=plain)
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertIn("not inside a git repository", out)
        self.assertFalse((plain / ".git").exists())
        self.assertTrue((plain / ".claude" / "rules" / "a.md").exists())

    def test_no_git_hooks_flag_skips_the_step(self):
        self.hooks.mkdir(exist_ok=True)
        (self.hooks / "pre-push").write_bytes(FOREIGN)  # a conflict that must not even be looked at
        code, out, err = self.run_cli("install", "--no-git-hooks")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertNotIn("git hooks", out)
        self.assertFalse((self.hooks / "pre-commit").exists())
        self.assertTrue((self.proj / ".claude" / "rules" / "a.md").exists())

    def test_pack_without_git_hooks_source_behaves_as_before(self):
        plain_pack = self.make_pack(git_hooks_source=None)
        for action in ("install", "verify", "uninstall"):
            code, out, err = self.run_cli(action, pack=plain_pack)
            self.assertEqual(code, installer.EXIT_OK, out + err)
            self.assertNotIn("git hooks", out + err)
        self.assertFalse((self.hooks / "pre-commit").exists())

    def test_real_conflict_makes_the_process_exit_with_code_3(self):
        """End to end: `python3 install.py install` with a foreign hook present exits 3 (not just a constant)."""
        self.hooks.mkdir(exist_ok=True)
        (self.hooks / "pre-push").write_bytes(FOREIGN)
        script = Path(install.__file__).resolve()
        r = subprocess.run([sys.executable, str(script), "install", "--project", str(self.proj)], cwd=str(self.root),
                           env=dict(os.environ), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(installer.EXIT_CONFLICT, 3)
        self.assertIn("CONFLICT:", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertEqual((self.hooks / "pre-push").read_bytes(), FOREIGN)
        self.assertEqual((self.hooks / "pre-commit").read_bytes(), GUARD.read_bytes())
        # without the conflict the same command exits 0
        (self.hooks / "pre-push").unlink()
        r = subprocess.run([sys.executable, str(script), "install", "--project", str(self.proj)], cwd=str(self.root),
                           env=dict(os.environ), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores directory permissions")
    def test_unwritable_hooks_dir_is_a_conflict_not_a_traceback(self):
        self.hooks.mkdir(exist_ok=True)
        self.hooks.chmod(0o555)  # read-only: creating the hook files raises PermissionError (an OSError)
        self.addCleanup(self.hooks.chmod, 0o755)  # let the temp dir be removed afterwards
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        self.assertNotIn("Traceback", out + err)
        self.assertIn("CONFLICT:", err)
        self.assertIn("could not be written", err)
        for n in HOOK_NAMES:
            self.assertIn(f"NOT active for {n}", err)
            self.assertFalse((self.hooks / n).exists(), n)
        self.assertTrue(err.rstrip().splitlines()[-1].startswith("  - "), "summary comes last")
        self.assertTrue((self.proj / ".claude" / "rules" / "a.md").exists())  # the managed copy was still applied

    def test_failing_copy_in_one_hook_does_not_stop_the_others(self):
        real_copy = shutil.copyfile

        def flaky(src, dst, *a, **kw):
            if Path(dst).name == "pre-merge-commit":
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_copy(src, dst, *a, **kw)

        with mock.patch.object(installer.shutil, "copyfile", side_effect=flaky):
            code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)
        self.assertNotIn("Traceback", out + err)
        self.assertIn("pre-merge-commit", err)
        self.assertIn("No space left", err)
        self.assertEqual((self.hooks / "pre-commit").read_bytes(), GUARD.read_bytes())
        self.assertEqual((self.hooks / "pre-push").read_bytes(), GUARD.read_bytes())
        self.assertFalse((self.hooks / "pre-merge-commit").exists())


class RepoResolutionTest(GitHooksInstallerBase):
    """Which repository gets the hooks: the PROJECT's (parent of .claude), found without inherited GIT_* variables."""

    def test_inherited_git_environment_does_not_repoint_the_installer(self):
        decoy = self.root / "decoy"
        decoy.mkdir()
        self.init_repo(decoy)
        polluted = {"GIT_DIR": str(decoy / ".git"), "GIT_COMMON_DIR": str(decoy / ".git"),
                    "GIT_WORK_TREE": str(decoy), "GIT_INDEX_FILE": str(decoy / ".git" / "index")}
        with mock.patch.dict(os.environ, polluted):
            # precondition: with these variables a plain `git -C <project>` really lands in the decoy
            seen = subprocess.run(["git", "-C", str(self.proj), "rev-parse", "--absolute-git-dir"],
                                  env=dict(os.environ), capture_output=True, text=True).stdout.strip()
            self.assertEqual(Path(seen), decoy / ".git")
            for action in ("install", "verify"):
                code, out, err = self.run_cli(action)
                self.assertEqual(code, installer.EXIT_OK, out + err)
            self.assertOurHooks()  # in the project's own repository
            for n in HOOK_NAMES:
                self.assertFalse((decoy / ".git" / "hooks" / n).exists(), n)
            code, out, err = self.run_cli("uninstall")
            self.assertEqual(code, installer.EXIT_OK, out + err)
        for n in HOOK_NAMES:
            self.assertFalse((self.hooks / n).exists(), n)

    def test_repo_nested_at_dot_claude_never_receives_the_hooks(self):
        nested = self.proj / ".claude"
        nested.mkdir()
        self.init_repo(nested)  # e.g. a dotfiles-style repo living in .claude itself
        code, out, err = self.run_cli("install")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertOurHooks()  # the outer project repository got them
        for n in HOOK_NAMES:
            self.assertFalse((nested / ".git" / "hooks" / n).exists(), n)
        code, out, err = self.run_cli("verify")
        self.assertEqual(code, 0, out + err)
        self.assertIn("OK: 3", out)
        self.assertIn(str(self.hooks), out)
        code, out, err = self.run_cli("uninstall")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        for n in HOOK_NAMES:
            self.assertFalse((self.hooks / n).exists(), n)

    def test_project_outside_any_repository_is_skipped_even_if_dot_claude_is_a_repo(self):
        plain = self.root / "plain"
        (plain / ".claude").mkdir(parents=True)
        self.init_repo(plain / ".claude")
        code, out, err = self.run_cli("install", project=plain)
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertIn("not inside a git repository", out)
        for n in HOOK_NAMES:
            self.assertFalse((plain / ".claude" / ".git" / "hooks" / n).exists(), n)
        code, out, err = self.run_cli("verify", project=plain)
        self.assertEqual(code, 0, out + err)
        self.assertIn("info: git hooks not checked (not inside a git repository)", out)


class DryRunTest(GitHooksInstallerBase):
    def test_dry_run_on_a_fresh_project_writes_nothing_and_still_sees_the_repo(self):
        before = self.snapshot()
        self.assertFalse((self.proj / ".claude").exists())  # git must be probed from the nearest existing ancestor
        code, out, err = self.run_cli("install", "--dry-run")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertEqual(out.count("[NEW]"), 1 + 3)
        self.assertNotIn("not inside a git repository", out)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.proj / ".claude").exists())

    def test_dry_run_reports_update_and_skip_without_writing(self):
        self.hooks.mkdir(exist_ok=True)
        (self.hooks / "pre-commit").write_bytes(OLD_OURS)
        (self.hooks / "pre-commit").chmod(0o755)
        (self.hooks / "pre-push").write_bytes(FOREIGN)
        before = self.snapshot()
        code, out, err = self.run_cli("update", "--dry-run")
        self.assertEqual(code, installer.EXIT_CONFLICT, out + err)  # what the real run would return
        self.assertIn("[UPDATE]", out)
        self.assertIn("[FOREIGN]", out)
        self.assertIn("[NEW]", out)
        self.assertEqual(self.snapshot(), before)

    def test_dry_run_with_hookspath_writes_nothing(self):
        self.run_git("config", "core.hooksPath", ".husky", cwd=self.proj)
        before = self.snapshot()
        code, out, err = self.run_cli("install", "--dry-run")
        self.assertEqual(code, installer.EXIT_CONFLICT)
        self.assertIn("[SKIPPED] core.hooksPath=.husky", out)
        self.assertEqual(self.snapshot(), before)


class UninstallAndVerifyTest(GitHooksInstallerBase):
    def test_uninstall_removes_only_hooks_with_our_marker(self):
        self.run_cli("install")
        (self.hooks / "pre-push").write_bytes(FOREIGN)
        code, out, err = self.run_cli("uninstall")
        self.assertEqual(code, installer.EXIT_OK, out + err)
        self.assertFalse((self.hooks / "pre-commit").exists())
        self.assertFalse((self.hooks / "pre-merge-commit").exists())
        self.assertEqual((self.hooks / "pre-push").read_bytes(), FOREIGN)
        self.assertIn("left in place (not ours)", out)

    def test_uninstall_removes_ours_even_when_hookspath_is_now_set(self):
        self.run_cli("install")
        self.run_git("config", "core.hooksPath", ".husky", cwd=self.proj)
        self.run_cli("uninstall")
        for n in HOOK_NAMES:
            self.assertFalse((self.hooks / n).exists(), n)

    def test_uninstall_dry_run_and_no_git_hooks_keep_them(self):
        self.run_cli("install")
        for extra in (("--dry-run",), ("--no-git-hooks",)):
            self.run_cli("uninstall", *extra)
            self.assertOurHooks()

    def test_uninstall_never_touches_symlinks_or_other_hook_names(self):
        self.run_cli("install")
        outside = self.root / "outside"
        outside.write_bytes(GUARD.read_bytes())
        (self.hooks / "pre-push").unlink()
        (self.hooks / "pre-push").symlink_to(outside)
        (self.hooks / "post-commit").write_bytes(GUARD.read_bytes())  # marker'd, but not one of the three names
        self.run_cli("uninstall")
        self.assertTrue((self.hooks / "pre-push").is_symlink())
        self.assertTrue(outside.exists())
        self.assertTrue((self.hooks / "post-commit").exists())

    def test_verify_ok_then_modified_missing_and_foreign(self):
        self.run_cli("install")
        code, out, err = self.run_cli("verify")
        self.assertEqual(code, 0, out + err)
        self.assertIn("OK: 3", out)
        (self.hooks / "pre-commit").write_bytes(GUARD.read_bytes() + b"# edited\n")
        (self.hooks / "pre-commit").chmod(0o755)
        (self.hooks / "pre-merge-commit").unlink()
        (self.hooks / "pre-push").write_bytes(FOREIGN)
        code, out, err = self.run_cli("verify")
        self.assertEqual(code, 1)
        for block in ("MODIFIED: 1\n  - pre-commit\n", "MISSING: 1\n  - pre-merge-commit\n",
                      "FOREIGN: 1\n  - pre-push\n", "OK: 0\n"):
            self.assertIn(block, out)

    def test_verify_warns_loudly_but_exits_0_when_hookspath_is_set_after_install(self):
        self.run_cli("install")
        self.run_git("config", "core.hooksPath", ".husky", cwd=self.proj)
        code, out, err = self.run_cli("verify")
        self.assertEqual(code, 0, out + err)  # legitimately skipped: not a verify failure
        warnings = [ln for ln in out.splitlines() if ln.startswith("WARNING:")]
        self.assertEqual(len(warnings), 1, out)
        for needle in ("core.hooksPath=.husky", "git-native guard is NOT active in this repository",
                       "git hooks not checked"):
            self.assertIn(needle, warnings[0])
        self.assertNotIn("info: git hooks not checked (core.hooksPath", out)  # it is no longer an info line

    def test_verify_treats_not_a_repository_as_info_not_failure(self):
        plain = self.root / "plain"
        plain.mkdir()
        self.run_cli("install", project=plain)
        code, out, err = self.run_cli("verify", project=plain)
        self.assertEqual(code, 0, out + err)
        self.assertIn("info: git hooks not checked (not inside a git repository)", out)

    def test_verify_no_git_hooks_ignores_missing_hooks(self):
        self.run_cli("install")
        (self.hooks / "pre-push").unlink()
        self.assertEqual(self.run_cli("verify")[0], 1)
        code, out, err = self.run_cli("verify", "--no-git-hooks")
        self.assertEqual(code, 0, out + err)
        self.assertNotIn("git hooks", out)


class BoundaryTest(GitHooksInstallerBase):
    def test_only_the_three_names_pass_the_boundary_guard(self):
        hooks = self.hooks
        for name in HOOK_NAMES:
            self.assertEqual(installer.path_within_git_hooks(hooks, name), hooks / name)
        for bad in ("pre-rebase", "post-commit", "../config", "sub/pre-commit", "pre-commit/../../config",
                    "/etc/passwd", "pre-commit ", ""):
            with self.subTest(name=bad):
                with self.assertRaises(installer.BoundaryViolation):
                    installer.path_within_git_hooks(hooks, bad)

    def test_install_writes_nothing_outside_dot_claude_except_the_three_hooks(self):
        before = self.snapshot()
        for action in ("install", "update", "verify", "uninstall"):
            self.run_cli(action)
            self.run_cli(action, "--force")
        after = self.snapshot()
        allowed = {self.hooks / n for n in HOOK_NAMES}
        for p in self.changed_paths(before, after):
            self.assertTrue(self.proj / ".claude" in p.parents or p in allowed, p)
        # the git directory itself (config, refs, other hooks) is untouched
        git_before = {p: v for p, v in before.items() if self.proj / ".git" in p.parents and p not in allowed}
        self.assertEqual({p: after.get(p) for p in git_before}, git_before)

    def test_install_run_twice_leaves_the_repo_config_alone(self):
        self.run_cli("install")
        r = self.run_git("config", "--local", "--list", cwd=self.proj)
        self.assertNotIn("hookspath", r.stdout.lower())


if __name__ == "__main__":
    unittest.main()
