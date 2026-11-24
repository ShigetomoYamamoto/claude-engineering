#!/usr/bin/env python3
"""stdlib-only unittest suite for git-hooks/guard.sh (the git-native guard).

Every test runs real git against throw-away repositories (plus a bare "remote")
under a temp dir, with a hermetic environment: empty GIT_CONFIG_GLOBAL,
GIT_CONFIG_NOSYSTEM=1, a temp HOME, GIT_CEILING_DIRECTORIES at the temp root, no
inherited GIT_* variables, and CLAUDECODE set or unset explicitly per command.
Nothing ever touches a real repository or any git config outside the temp dir.

The "documented gaps" and "known bypasses" tests pin down what the hooks do NOT
stop; git-hooks/README.md carries the same matrix and must be updated with them.
"""

import atexit
import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

GUARD = Path(__file__).resolve().parent.parent / "git-hooks" / "guard.sh"
HOOK_NAMES = ("pre-commit", "pre-merge-commit", "pre-push")
MARK = "[claudeguard]"


def hermetic_env(root: Path) -> dict:
    """Environment for git: empty global config, no system config, temp HOME, ceiling at `root`."""
    (root / "home").mkdir(exist_ok=True)
    (root / "gitconfig").write_text("")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "CLAUDECODE"}
    env.update(
        HOME=str(root / "home"),
        GIT_CONFIG_GLOBAL=str(root / "gitconfig"),
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CEILING_DIRECTORIES=str(root),
        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
        GIT_TERMINAL_PROMPT="0", GIT_EDITOR="true", GIT_MERGE_AUTOEDIT="no", LC_ALL="C",
        FILTER_BRANCH_SQUELCH_WARNING="1",
    )
    return env


def run_git(env, *args, cwd, claude=None, input=None):
    """Run git; `claude` None = CLAUDECODE unset, otherwise that exact value."""
    env = dict(env)
    if claude is not None:
        env["CLAUDECODE"] = claude
    return subprocess.run(["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True, input=input)


def install_guard(repo: Path) -> None:
    hooks = repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for name in HOOK_NAMES:
        shutil.copyfile(GUARD, hooks / name)
        (hooks / name).chmod(0o755)  # a hook without the exec bit is silently ignored by git


_TEMPLATE = None  # built once per process: git is slow to spawn on a busy machine


def _template_world() -> Path:
    """Bare remote + repo with the guard installed and these refs: main (= remote main), develop and
    release/1.0 on the remote, feature = main + one commit. Tests copy it instead of rebuilding it."""
    global _TEMPLATE
    if _TEMPLATE is None:
        root = Path(tempfile.mkdtemp(prefix="guard-template-")).resolve()
        atexit.register(shutil.rmtree, root, ignore_errors=True)
        env, remote, repo = hermetic_env(root), root / "remote.git", root / "repo"
        repo.mkdir()

        def g(*args, cwd=repo):
            r = run_git(env, *args, cwd=cwd)
            assert r.returncode == 0, f"template: git {' '.join(args)}: {r.stderr}"

        g("init", "-q", "--bare", "-b", "main", str(remote), cwd=root)
        g("config", "receive.denyDeleteCurrent", "ignore", cwd=remote)  # else the remote refuses on its own
        g("init", "-q", "-b", "main")
        install_guard(repo)
        for name, msg in (("base", "base"), ("f1", "f1")):
            if name == "f1":
                g("switch", "-q", "-c", "feature")
            (repo / name).write_text(name + "\n")
            g("add", name)
            g("commit", "-q", "-m", msg)
            if name == "base":
                g("remote", "add", "origin", str(remote))
                for b in ("main", "develop", "release/1.0"):
                    g("push", "-q", "origin", f"main:refs/heads/{b}")
        g("switch", "-q", "main")
        _TEMPLATE = root
    return _TEMPLATE


class GitSandbox(unittest.TestCase):
    """Hermetic git environment (no tests of its own; reused by test_installer_git_hooks)."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.env = hermetic_env(self.root)
        # In-process calls (installer.main -> subprocess git) must be hermetic as well.
        patcher = mock.patch.dict(os.environ, self.env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_git(self, *args, cwd, claude=None, input=None):
        return run_git(self.env, *args, cwd=cwd, claude=claude, input=input)


class GuardTestBase(GitSandbox):
    """A copy of the template world: self.repo (main checked out) and self.remote (bare)."""

    def git(self, *args, claude=None, cwd=None, input=None):
        return self.run_git(*args, cwd=cwd or self.repo, claude=claude, input=input)

    def ok(self, *args, **kw):
        r = self.git(*args, **kw)
        self.assertEqual(r.returncode, 0, f"git {' '.join(args)} failed: {r.stdout}{r.stderr}")
        return r.stdout.strip()

    def commit(self, name, claude=None, *extra, cwd=None):
        (Path(cwd or self.repo) / name).write_text(name + "\n")
        self.ok("add", name, cwd=cwd)
        return self.git("commit", "-q", "-m", name, *extra, claude=claude, cwd=cwd)

    def make_world(self, tag="w"):
        base = self.root / tag
        base.mkdir()
        self.remote, self.repo = base / "remote.git", base / "repo"
        shutil.copytree(_template_world() / "remote.git", self.remote)
        shutil.copytree(_template_world() / "repo", self.repo)
        self.ok("remote", "set-url", "origin", str(self.remote))

    def install_hooks(self, repo: Path) -> None:
        install_guard(repo)

    def setUp(self) -> None:
        super().setUp()
        self.make_world()

    def rev(self, ref="HEAD", cwd=None):
        return self.ok("rev-parse", ref, cwd=cwd)

    def run_hook(self, name, *, repo=None, claude="1", stdin="", path_prefix=None):
        """Run an installed hook file directly, the way git would (cwd = work tree, stdin for pre-push)."""
        repo = repo or self.repo
        env = {**self.env, "CLAUDECODE": claude}
        if path_prefix:
            env["PATH"] = f"{path_prefix}{os.pathsep}{env['PATH']}"
        return subprocess.run([str(repo / ".git" / "hooks" / name)], cwd=str(repo), env=env, input=stdin,
                              capture_output=True, text=True)

    @contextlib.contextmanager
    def on_branch(self, name):
        """Check out `name` (created from main unless it is main); clean up afterwards."""
        self.ok("switch", "-q", "main")
        if name != "main":
            self.ok("switch", "-q", "-c", name, "main")
        try:
            yield
        finally:
            self.ok("reset", "-q", "--hard")
            self.ok("switch", "-q", "main")
            if name != "main":
                self.ok("branch", "-q", "-D", name)

    def remote_rev(self, branch):
        r = self.git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", cwd=self.remote)
        return r.stdout.strip() or None

    def assertBlocked(self, r, *, hook=None):
        self.assertNotEqual(r.returncode, 0, f"expected a block, got success: {r.stdout}{r.stderr}")
        self.assertIn(MARK, r.stderr)
        if hook:
            self.assertIn(f"({hook})", r.stderr)

    def assertAllowed(self, r):
        self.assertEqual(r.returncode, 0, f"expected success: {r.stdout}{r.stderr}")
        self.assertNotIn(MARK, r.stderr)


class HumanIsNeverAffectedTest(GuardTestBase):
    """CLAUDECODE unset / not exactly "1": every operation is allowed and really happens."""

    def test_everything_succeeds_without_claudecode_1(self):
        for i, claude in enumerate((None, "0", "", "true", "yes", "11")):
            with self.subTest(CLAUDECODE=claude):
                self.make_world(f"human{i}")
                self.assertAllowed(self.commit("h1", claude))
                self.assertAllowed(self.git("push", "origin", "main", claude=claude))
                self.assertEqual(self.remote_rev("main"), self.rev("main"))
                self.assertAllowed(self.git("commit", "-q", "--amend", "-m", "h1b", claude=claude))
                self.assertAllowed(self.git("push", "--force", "origin", "main", claude=claude))
                self.assertEqual(self.remote_rev("main"), self.rev("main"))
                self.assertAllowed(self.git("merge", "-q", "--no-ff", "-m", "m", "feature", claude=claude))
                self.assertAllowed(self.git("push", "origin", "main:develop", claude=claude))
                self.assertAllowed(self.git("push", "origin", ":develop", claude=claude))
                self.assertAllowed(self.git("push", "origin", "--delete", "main", claude=claude))
                self.assertIsNone(self.remote_rev("develop"))
                self.assertIsNone(self.remote_rev("main"))


class CommitHooksTest(GuardTestBase):
    """pre-commit / pre-merge-commit with CLAUDECODE=1."""

    def test_commit_on_every_default_protected_branch_is_blocked(self):
        for b in ("main", "master", "develop", "development", "staging", "release", "production", "prod",
                  "trunk", "release/1.0", "develop/x"):
            with self.subTest(branch=b), self.on_branch(b):
                before = self.rev()
                r = self.commit("c", "1")
                self.assertBlocked(r, hook="pre-commit")
                self.assertIn(b, r.stderr)
                self.assertEqual(self.rev(), before)

    def test_commit_on_other_branches_is_allowed(self):
        for b in ("topic", "mainline", "develop-x", "release-2", "hotfix/main", "wip"):
            with self.subTest(branch=b), self.on_branch(b):
                before = self.rev()
                self.assertAllowed(self.commit("c", "1"))
                self.assertNotEqual(self.rev(), before)

    def test_amend_on_main_is_blocked(self):
        before = self.rev()
        self.assertBlocked(self.git("commit", "-q", "--amend", "-m", "x", claude="1"), hook="pre-commit")
        self.assertEqual(self.rev(), before)

    def test_message_is_japanese_and_says_what_to_do(self):
        r = self.commit("c", "1")
        self.assertEqual(r.returncode, 1)
        for needle in ("保護ブランチ", "main", "pre-commit", "作業ブランチ", "PR"):
            self.assertIn(needle, r.stderr)
        self.assertNotIn("protectedBranches", r.stderr)  # the opt-out key is not advertised to the agent

    def test_first_commit_in_unborn_repo_is_allowed(self):
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.ok("init", "-q", "-b", "main", cwd=fresh)
        self.install_hooks(fresh)
        self.assertAllowed(self.commit("first", "1", cwd=fresh))
        self.assertBlocked(self.commit("second", "1", cwd=fresh), hook="pre-commit")  # only the FIRST is free

    def test_detached_head_is_allowed(self):
        self.ok("switch", "-q", "--detach", "main")
        self.assertAllowed(self.commit("d1", "1"))

    def test_same_named_tag_does_not_hide_the_branch(self):
        """`git symbolic-ref --short` prints "heads/main" when a tag `main` exists; the guard uses the full ref."""
        self.ok("tag", "main")
        self.ok("tag", "develop")
        before = self.rev()
        self.assertBlocked(self.commit("c", "1"), hook="pre-commit")
        self.assertEqual(self.rev(), before)
        self.assertBlocked(self.run_hook("pre-merge-commit"), hook="pre-merge-commit")
        # develop has a same-named tag too (the bare name is ambiguous here, so spell out refs/heads/main)
        self.ok("switch", "-q", "-c", "develop", "refs/heads/main")
        before = self.rev("refs/heads/develop")
        self.assertBlocked(self.commit("d", "1"), hook="pre-commit")
        self.assertEqual(self.rev("refs/heads/develop"), before)

    def test_pre_merge_commit_allows_detached_and_unborn_head(self):
        self.assertBlocked(self.run_hook("pre-merge-commit"), hook="pre-merge-commit")  # baseline: on main
        self.ok("switch", "-q", "--detach", "main")
        r = self.run_hook("pre-merge-commit")
        self.assertEqual((r.returncode, r.stderr), (0, ""))
        fresh = self.root / "fresh-merge"
        fresh.mkdir()
        self.ok("init", "-q", "-b", "main", cwd=fresh)
        self.install_hooks(fresh)
        r = self.run_hook("pre-merge-commit", repo=fresh)
        self.assertEqual((r.returncode, r.stderr), (0, ""))

    def test_merge_commit_on_main_is_blocked_but_fast_forward_is_not_hooked(self):
        self.commit("m1")  # main diverges from feature, so a real merge commit is needed
        before = self.rev()
        self.assertBlocked(self.git("merge", "-q", "--no-ff", "-m", "mm", "feature", claude="1"),
                           hook="pre-merge-commit")
        self.assertEqual(self.rev(), before)
        # a fast-forward merge creates no commit: no hook runs (documented gap)
        self.ok("reset", "-q", "--hard", "HEAD~1")
        self.assertAllowed(self.git("merge", "-q", "feature", claude="1"))
        self.assertEqual(self.rev(), self.rev("feature"))

    def test_merge_on_feature_branch_is_allowed(self):
        self.ok("switch", "-q", "-c", "other", "main")
        self.commit("o1")
        self.assertAllowed(self.git("merge", "-q", "--no-ff", "-m", "mm", "feature", claude="1"))

    def test_squash_merge_then_commit_is_blocked_at_commit(self):
        self.assertAllowed(self.git("merge", "--squash", "feature", claude="1"))  # no commit yet: nothing to hook
        self.assertBlocked(self.git("commit", "-q", "-m", "sq", claude="1"), hook="pre-commit")

    def test_conflict_resolution_commit_on_main_is_blocked(self):
        self.ok("switch", "-q", "feature")
        (self.repo / "base").write_text("feature side\n")
        self.ok("commit", "-q", "-am", "f-edit")
        self.ok("switch", "-q", "main")
        (self.repo / "base").write_text("main side\n")
        self.ok("commit", "-q", "-am", "m-edit")
        r = self.git("merge", "feature", claude="1")  # conflicts: no commit, so no hook
        self.assertNotIn(MARK, r.stderr)
        (self.repo / "base").write_text("resolved\n")
        self.ok("add", "base")
        self.assertBlocked(self.git("commit", "-q", "-m", "res", claude="1"), hook="pre-commit")

    def test_linked_worktree_shares_the_hooks(self):
        wt = self.root / "w" / "wt"
        self.ok("worktree", "add", "-q", "-b", "develop", str(wt), "main")
        self.assertBlocked(self.commit("w1", "1", cwd=wt), hook="pre-commit")
        self.ok("switch", "-q", "-c", "wt-feature", cwd=wt)
        self.assertAllowed(self.commit("w2", "1", cwd=wt))


class PushHookTest(GuardTestBase):
    """pre-push with CLAUDECODE=1."""

    def test_push_to_protected_remote_branch_is_blocked(self):
        cases = {
            "main": ("feature:main", "main"),
            "develop": ("feature:develop", "develop"),
            "release/1.0": ("feature:refs/heads/release/1.0", "release/1.0"),
            "HEAD:main": ("HEAD:main", "main"),
        }
        self.ok("switch", "-q", "feature")
        for label, (refspec, remote_branch) in cases.items():
            with self.subTest(refspec=label):
                before = self.remote_rev(remote_branch)
                r = self.git("push", "origin", refspec, claude="1")  # a fast-forward: only our hook can refuse it
                self.assertBlocked(r, hook="pre-push")
                self.assertIn(f"refs/heads/{remote_branch}", r.stderr)
                self.assertEqual(self.remote_rev(remote_branch), before)

    def test_push_from_local_main_is_blocked(self):
        self.commit("m1")
        before = self.remote_rev("main")
        self.assertBlocked(self.git("push", "origin", "main", claude="1"), hook="pre-push")
        self.assertEqual(self.remote_rev("main"), before)

    def test_force_push_to_protected_branch_is_blocked(self):
        self.ok("switch", "-q", "-c", "other", "main")
        self.commit("o1")
        self.ok("push", "-q", "origin", "other:main")  # human advances the remote, so feature:main needs --force
        before = self.remote_rev("main")
        for flag in ("--force", "--force-with-lease", "-f"):
            with self.subTest(flag=flag):
                self.assertBlocked(self.git("push", flag, "origin", "feature:main", claude="1"), hook="pre-push")
                self.assertEqual(self.remote_rev("main"), before)

    def test_deleting_a_protected_remote_branch_is_blocked(self):
        for args in ((":main",), ("--delete", "main"), (":develop",), (":refs/heads/release/1.0",)):
            with self.subTest(args=args):
                self.assertBlocked(self.git("push", "origin", *args, claude="1"), hook="pre-push")
        for b in ("main", "develop", "release/1.0"):
            self.assertIsNotNone(self.remote_rev(b))

    def test_feature_branches_push_force_and_delete_are_allowed(self):
        self.ok("switch", "-q", "feature")
        self.assertAllowed(self.git("push", "-q", "origin", "feature", claude="1"))
        self.assertEqual(self.remote_rev("feature"), self.rev())
        self.ok("commit", "-q", "--amend", "-m", "f1b", claude="1")  # feature is unprotected: commit OK
        self.assertAllowed(self.git("push", "-q", "--force", "origin", "feature", claude="1"))
        self.assertEqual(self.remote_rev("feature"), self.rev())
        for name in ("mainline", "develop-x", "release-2", "hotfix/main", "topic/x"):
            self.assertAllowed(self.git("push", "-q", "origin", f"feature:refs/heads/{name}", claude="1"))
            self.assertIsNotNone(self.remote_rev(name), name)
        self.assertAllowed(self.git("push", "-q", "origin", ":feature", claude="1"))
        self.assertAllowed(self.git("push", "-q", "origin", "--delete", "mainline", claude="1"))
        self.assertIsNone(self.remote_rev("feature"))
        self.assertIsNone(self.remote_rev("mainline"))

    def test_tag_push_is_allowed(self):
        self.ok("tag", "v1")
        self.assertAllowed(self.git("push", "-q", "origin", "v1", claude="1"))
        self.assertAllowed(self.git("push", "-q", "origin", "--tags", claude="1"))
        self.assertAllowed(self.git("push", "-q", "origin", "--delete", "v1", claude="1"))

    def test_tag_force_push_and_a_tag_named_like_a_protected_branch_are_allowed(self):
        self.ok("tag", "v1")
        self.assertAllowed(self.git("push", "-q", "origin", "v1", claude="1"))
        self.ok("tag", "-f", "v1", "feature")  # move the tag, then force-push it
        self.assertAllowed(self.git("push", "-q", "--force", "origin", "v1", claude="1"))
        self.assertEqual(self.git("rev-parse", "refs/tags/v1", cwd=self.remote).stdout.strip(), self.rev("feature"))
        self.ok("tag", "main")  # refs/tags/main is not refs/heads/main
        self.assertAllowed(self.git("push", "-q", "origin", "refs/tags/main", claude="1"))

    def test_direct_hook_input_covers_delete_lines_and_tags(self):
        hook = self.repo / ".git" / "hooks" / "pre-push"
        z = "0" * 40
        sha = self.rev()
        for line, blocked in (
            (f"(delete) {z} refs/heads/main {sha}\n", True),
            (f"refs/heads/f {sha} refs/heads/feature {z}\n", False),
            (f"refs/tags/v1 {sha} refs/tags/main {z}\n", False),
            (f"refs/heads/f {sha} refs/heads/f2 {z}\nrefs/heads/f {sha} refs/heads/develop {z}\n", True),
            ("", False),
        ):
            with self.subTest(stdin=line):
                r = subprocess.run([str(hook), "origin", "url"], cwd=str(self.repo), input=line, text=True,
                                   env={**self.env, "CLAUDECODE": "1"}, capture_output=True)
                self.assertEqual(r.returncode != 0, blocked, r.stderr)


class OverrideTest(GuardTestBase):
    """claudeguard.protectedBranches: unset = default, space-separated globs, empty = disabled."""

    def test_custom_list_replaces_the_default(self):
        self.ok("config", "claudeguard.protectedBranches", "wip* release/*")
        self.assertAllowed(self.commit("m1", "1"))  # main is no longer protected
        self.ok("switch", "-q", "-c", "wip-1", "main")
        self.assertBlocked(self.commit("w1", "1"), hook="pre-commit")
        self.assertBlocked(self.git("push", "origin", "wip-1:refs/heads/wip-2", claude="1"), hook="pre-push")
        self.assertBlocked(self.git("push", "origin", "feature:release/1.0", claude="1"), hook="pre-push")
        self.assertAllowed(self.git("push", "-q", "origin", "feature:develop", claude="1"))

    def test_empty_value_disables_protection(self):
        self.ok("config", "claudeguard.protectedBranches", "")
        self.assertAllowed(self.commit("m1", "1"))
        self.assertAllowed(self.git("push", "-q", "origin", "main", claude="1"))
        self.assertAllowed(self.git("push", "-q", "origin", ":develop", claude="1"))

    def test_unset_means_default_again(self):
        self.ok("config", "claudeguard.protectedBranches", "")
        self.ok("config", "--unset", "claudeguard.protectedBranches")
        self.assertBlocked(self.commit("m1", "1"), hook="pre-commit")

    def test_star_pattern_is_a_glob_not_expanded_against_the_working_tree(self):
        self.ok("config", "claudeguard.protectedBranches", "*")  # `set -f` keeps `*` from becoming file names
        self.ok("switch", "-q", "feature")
        self.assertBlocked(self.commit("f2", "1"), hook="pre-commit")


class DocumentedGapsTest(GuardTestBase):
    """What the hooks do NOT stop (CLAUDECODE=1, on main). These pass today; git-hooks/README.md says so."""

    def test_ref_updates_that_run_no_hook_are_not_stopped(self):
        sha_f = self.rev("feature")
        patch = self.root / "f1.patch"
        patch.write_text(self.git("format-patch", "-1", "feature", "--stdout").stdout)  # raw, newline kept
        self.ok("push", "-q", "origin", "feature:refs/heads/feat-x")  # a remote branch for `fetch origin feat-x:main`
        g = lambda *a: (lambda: self.git(*a, claude="1"))  # noqa: E731
        cases = [  # (label, prepare, run); prepare keys: extra_commit, off_main (feature checked out), tmp_branch
            ("cherry-pick", {}, g("cherry-pick", sha_f)),
            ("revert", {"extra_commit": True}, g("revert", "--no-edit", "HEAD")),
            ("rebase (replays a commit)", {"extra_commit": True}, g("rebase", "feature")),
            ("reset --hard", {}, g("reset", "-q", "--hard", "feature")),
            ("update-ref", {}, g("update-ref", "refs/heads/main", sha_f)),
            ("branch -f", {"off_main": True}, g("branch", "-f", "main", sha_f)),
            ("branch -M", {"tmp_branch": True}, g("branch", "-M", "tmp", "main")),
            ("checkout -B", {}, g("checkout", "-q", "-B", "main", sha_f)),
            ("switch -C", {}, g("switch", "-q", "-C", "main", sha_f)),
            ("am", {}, g("am", "-q", str(patch))),
            ("pull --ff-only", {}, g("pull", "-q", "--ff-only", ".", "feature")),
            ("pull --rebase", {"extra_commit": True}, g("pull", "-q", "--rebase", ".", "feature")),
            ("fetch origin x:main", {"off_main": True}, g("fetch", "-q", "origin", "feat-x:main")),
            ("filter-branch", {}, g("filter-branch", "-f", "--env-filter", "export GIT_COMMITTER_NAME=zz", "main")),
        ]
        for label, prep, run in cases:
            with self.subTest(op=label):
                self.ok("switch", "-q", "-C", "main", self.remote_rev("main"))
                if prep.get("extra_commit"):
                    self.assertEqual(self.commit("m1").returncode, 0)  # human commit to revert / replay
                if prep.get("off_main"):
                    self.ok("switch", "-q", "feature")  # git refuses to update the checked-out branch here
                if prep.get("tmp_branch"):
                    self.ok("switch", "-q", "-c", "tmp", "feature")
                before = self.rev("main")
                self.assertAllowed(run())
                self.assertNotEqual(self.rev("main"), before)

    def test_send_pack_does_not_run_pre_push(self):
        before = self.remote_rev("main")
        r = self.git("send-pack", str(self.remote), "refs/heads/feature:refs/heads/main", claude="1")
        self.assertAllowed(r)
        self.assertNotEqual(self.remote_rev("main"), before)
        self.assertEqual(self.remote_rev("main"), self.rev("feature"))

    def test_known_bypasses_are_not_stopped(self):
        """Why the Claude-side PreToolUse hook blocks these command strings (best-effort)."""
        cases = {
            "--no-verify": ("commit", "-q", "--no-verify", "-m", "nv"),
            "-c core.hooksPath": ("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "hp"),
        }
        for label, args in cases.items():
            with self.subTest(bypass=label):
                (self.repo / f"bypass-{len(label)}.txt").write_text("x\n")
                self.ok("add", "-A")
                before = self.rev()
                self.assertAllowed(self.git(*args, claude="1"))
                self.assertNotEqual(self.rev(), before)
        self.assertAllowed(self.git("push", "-q", "--no-verify", "origin", "main", claude="1"))
        self.assertEqual(self.remote_rev("main"), self.rev("main"))
        # deleting the hook file, and unsetting/changing CLAUDECODE, switch the guard off as well
        (self.repo / ".git" / "hooks" / "pre-commit").unlink()
        self.assertAllowed(self.commit("nohook", "1"))
        self.install_hooks(self.repo)
        self.assertAllowed(self.commit("noenv", None))
        self.ok("config", "claudeguard.protectedBranches", "")  # an agent could even empty the override
        self.assertAllowed(self.commit("noprotect", "1"))


class FailOpenAndShellsTest(GuardTestBase):
    def test_unexpected_error_warns_and_allows(self):
        outside = self.root / "not-a-repo"
        outside.mkdir()
        hook = outside / "pre-commit"
        shutil.copyfile(GUARD, hook)
        r = subprocess.run(["sh", str(hook)], cwd=str(outside), env={**self.env, "CLAUDECODE": "1"},
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("警告", r.stderr)
        self.assertNotIn("保護ブランチ", r.stderr)

    def test_failing_git_calls_warn_and_allow(self):
        """Each git call the guard makes can fail on its own: warn on stderr, exit 0, never block by accident."""
        real_git = shutil.which("git", path=self.env["PATH"])
        shim = self.root / "shim"
        shim.mkdir()
        push_line = f"refs/heads/feature {'1' * 40} refs/heads/main {'0' * 40}\n"
        self.assertBlocked(self.run_hook("pre-commit"))  # baselines: the same inputs do block
        self.assertBlocked(self.run_hook("pre-push", stdin=push_line))
        for failing, hook, stdin in (("symbolic-ref", "pre-commit", ""), ("rev-parse", "pre-commit", ""),
                                     ("config", "pre-commit", ""), ("config", "pre-merge-commit", ""),
                                     ("config", "pre-push", push_line)):
            with self.subTest(failing=failing, hook=hook):
                (shim / "git").write_text(f'#!/bin/sh\n[ "$1" = {failing} ] && exit 128\nexec {real_git} "$@"\n')
                (shim / "git").chmod(0o755)
                r = self.run_hook(hook, stdin=stdin, path_prefix=shim)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("警告", r.stderr)
                self.assertIn(f"({failing})", r.stderr)
                self.assertNotIn("保護ブランチの更新を止めました", r.stderr)

    def test_invoked_under_the_name_guard_sh_does_nothing(self):
        """The hook kind comes from the file name, so a plain `guard.sh` call is a silent no-op."""
        copy = self.repo / "guard.sh"
        shutil.copyfile(GUARD, copy)
        push_line = f"refs/heads/feature {'1' * 40} refs/heads/main {'0' * 40}\n"
        for stdin in ("", push_line):
            r = subprocess.run(["sh", str(copy)], cwd=str(self.repo), env={**self.env, "CLAUDECODE": "1"},
                               input=stdin, capture_output=True, text=True)
            self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))  # on main, a protected branch

    def test_script_is_posix_sh(self):
        """Run the hooks under every available shell: dash is the strict one."""
        shells = [s for s in (["dash"], ["bash", "--posix"], ["sh"]) if shutil.which(s[0])]
        self.assertTrue(shells)
        z, sha = "0" * 40, self.rev()
        for sh in shells:
            with self.subTest(shell=sh[0]):
                env = {**self.env, "CLAUDECODE": "1"}
                for name, stdin, blocked in (
                    ("pre-commit", "", True),  # main is checked out
                    ("pre-merge-commit", "", True),
                    ("pre-push", f"refs/heads/feature {sha} refs/heads/main {sha}\n", True),
                    ("pre-push", f"refs/heads/feature {sha} refs/heads/feature {z}\n", False),
                ):
                    r = subprocess.run([*sh, str(self.repo / ".git" / "hooks" / name)], cwd=str(self.repo), env=env,
                                       input=stdin, capture_output=True, text=True)
                    self.assertEqual(r.returncode != 0, blocked, f"{sh} {name}: {r.stderr}")

    def test_marker_is_on_line_2_and_script_is_short(self):
        lines = GUARD.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "#!/bin/sh")
        self.assertEqual(lines[1], "# claude-engineering:guard v1")
        self.assertLessEqual(len(lines), 70)
        self.assertTrue(os.access(GUARD, os.X_OK))


if __name__ == "__main__":
    unittest.main()
