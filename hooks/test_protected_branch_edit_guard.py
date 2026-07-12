#!/usr/bin/env python3
"""protected-branch-edit-guard.py の契約テスト（stdlib unittest・依存追加なし）。

実行: python3 -m unittest hooks/test_protected_branch_edit_guard.py

hook は PreToolUse(Edit|Write|MultiEdit) で stdin から tool_input.file_path を
受け取り、編集対象ファイルが属するリポジトリが保護ブランチ上か（かつ develop 等の
secondary ブランチが存在するマルチブランチ運用中か）を判定して exit 2 でブロック
する。判定は cwd ではなく file_path の所在で行う（cwd 誤判定バグの修正・本ファイル
の主眼）。file_path が欠落／相対で解決不能な場合のみ、従来の cwd 判定にフォール
バックする（fail-safe）。
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "protected-branch-edit-guard.py")


def run_hook(file_path: str, cwd: str) -> int:
    """file_path を tool_input.file_path に載せて hook を cwd で起動し exit code を返す。"""
    payload = json.dumps({"tool_input": {"file_path": file_path}})
    proc = subprocess.run(
        ["python3", HOOK],
        input=payload,
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    return proc.returncode


def run_hook_no_file_path(cwd: str) -> int:
    """tool_input に file_path が無い状態で hook を cwd で起動し exit code を返す（fail-safe 検証用）。"""
    payload = json.dumps({"tool_input": {}})
    proc = subprocess.run(
        ["python3", HOOK],
        input=payload,
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    return proc.returncode


def _run(args, cwd):
    subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True)


def init_repo(path: str, branch: str = "main") -> None:
    _run(["git", "init", "-b", branch], path)
    _run(["git", "config", "user.email", "test@example.com"], path)
    _run(["git", "config", "user.name", "Test"], path)
    with open(os.path.join(path, "README.md"), "w") as f:
        f.write("init\n")
    _run(["git", "add", "."], path)
    _run(["git", "commit", "-m", "init"], path)


def add_worktree(repo_path: str, worktree_path: str, branch: str) -> None:
    _run(["git", "worktree", "add", "-b", branch, worktree_path], repo_path)


class ProtectedBranchEditGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="pbeg_test_")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_multi_branch_repo(self):
        """main + develop が存在する（git-flow 運用中とみなされる）リポを作る。"""
        repo = os.path.join(self.tmpdir, "repo")
        os.makedirs(repo)
        init_repo(repo, "main")
        _run(["git", "branch", "develop"], repo)
        return repo

    def _make_single_branch_repo(self):
        """main のみ存在するリポを作る（secondary ブランチ無し）。"""
        repo = os.path.join(self.tmpdir, "repo_single")
        os.makedirs(repo)
        init_repo(repo, "main")
        return repo

    # --- 回帰: file_path が保護ブランチ上のリポ内にあり cwd も同じリポ ---
    def test_edit_file_in_protected_multi_branch_repo_blocked(self):
        repo = self._make_multi_branch_repo()
        target = os.path.join(repo, "README.md")
        self.assertEqual(run_hook(target, repo), 2)

    def test_edit_file_in_protected_single_branch_repo_allowed(self):
        # secondary ブランチが存在しない(main のみ)ので許可
        repo = self._make_single_branch_repo()
        target = os.path.join(repo, "README.md")
        self.assertEqual(run_hook(target, repo), 0)

    # --- 新ケース: cwd ではなく file_path の所在で判定する ---
    def test_file_outside_any_repo_allowed_even_if_cwd_is_protected(self):
        # cwd は保護ブランチのリポのままだが、編集対象は git 管理外のファイル
        repo = self._make_multi_branch_repo()
        outside_dir = os.path.join(self.tmpdir, "not_a_repo")
        os.makedirs(outside_dir)
        outside_file = os.path.join(outside_dir, "memory.md")
        with open(outside_file, "w") as f:
            f.write("x\n")
        self.assertEqual(run_hook(outside_file, repo), 0)

    def test_file_in_feature_worktree_allowed_even_if_cwd_is_protected(self):
        # cwd は保護ブランチのリポのままだが、編集対象は feature ブランチの worktree 内
        repo = self._make_multi_branch_repo()
        worktree = os.path.join(self.tmpdir, "wt-feature")
        add_worktree(repo, worktree, "feature/x")
        target = os.path.join(worktree, "README.md")
        self.assertEqual(run_hook(target, repo), 0)

    # --- fail-safe: file_path 欠落時は従来の cwd 判定にフォールバック ---
    def test_missing_file_path_falls_back_to_cwd_and_blocks(self):
        repo = self._make_multi_branch_repo()
        self.assertEqual(run_hook_no_file_path(repo), 2)

    def test_missing_file_path_falls_back_to_cwd_and_allows_non_protected(self):
        repo = self._make_multi_branch_repo()
        _run(["git", "checkout", "-b", "feature/y"], repo)
        self.assertEqual(run_hook_no_file_path(repo), 0)


if __name__ == "__main__":
    unittest.main()
