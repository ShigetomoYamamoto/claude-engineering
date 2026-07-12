#!/usr/bin/env python3
"""git-destructive-blocker.py の契約テスト（stdlib unittest・依存追加なし）。

実行: python3 -m unittest hooks/test_git_destructive_blocker.py

hook は PreToolUse(Bash) で stdin から JSON を受け取り、保護ブランチ上での
破壊的な git 操作を exit 2 でブロックする。current_branch() は「git が実際に
走るディレクトリ」（`git -C <dir>` / 直前の `cd <dir>`）をコマンド文字列から
推定してそこで評価する（cwd 誤判定バグの修正・本ファイルの主眼）。
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-destructive-blocker.py")


def run_hook(command: str, cwd: str) -> int:
    """command を tool_input.command に載せて hook を cwd で起動し exit code を返す。"""
    payload = json.dumps({"tool_input": {"command": command}})
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
    """path に git init し、branch をカレントブランチにした初期コミット付きリポを作る。"""
    _run(["git", "init", "-b", branch], path)
    _run(["git", "config", "user.email", "test@example.com"], path)
    _run(["git", "config", "user.name", "Test"], path)
    with open(os.path.join(path, "README.md"), "w") as f:
        f.write("init\n")
    _run(["git", "add", "."], path)
    _run(["git", "commit", "-m", "init"], path)


def add_worktree(repo_path: str, worktree_path: str, branch: str) -> None:
    """repo_path から新規ブランチ branch の worktree を worktree_path に作る。"""
    _run(["git", "worktree", "add", "-b", branch, worktree_path], repo_path)


class GitDestructiveBlockerTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="gdb_test_")
        self.repo = os.path.join(self.tmpdir, "repo")
        os.makedirs(self.repo)
        init_repo(self.repo, "main")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # --- 回帰: cwd = 保護ブランチ上のリポ（-C/cd を含まない従来ケース） ---
    def test_commit_on_protected_branch_blocked(self):
        self.assertEqual(run_hook("git commit -m x", self.repo), 2)

    def test_push_on_protected_branch_blocked(self):
        self.assertEqual(run_hook("git push", self.repo), 2)

    def test_force_push_to_protected_branch_blocked(self):
        self.assertEqual(run_hook("git push --force origin main", self.repo), 2)

    def test_reset_hard_with_unpushed_commits_blocked(self):
        remote = os.path.join(self.tmpdir, "remote.git")
        _run(["git", "init", "--bare", "-b", "main", remote], self.tmpdir)
        _run(["git", "remote", "add", "origin", remote], self.repo)
        _run(["git", "push", "-u", "origin", "main"], self.repo)
        with open(os.path.join(self.repo, "a.txt"), "w") as f:
            f.write("a\n")
        _run(["git", "add", "."], self.repo)
        _run(["git", "commit", "-m", "unpushed"], self.repo)
        self.assertEqual(run_hook("git reset --hard HEAD~1", self.repo), 2)

    def test_clean_fd_blocked(self):
        self.assertEqual(run_hook("git clean -fd", self.repo), 2)

    def test_status_allowed(self):
        self.assertEqual(run_hook("git status", self.repo), 0)

    def test_push_on_non_protected_branch_allowed(self):
        _run(["git", "checkout", "-b", "feature/x"], self.repo)
        self.assertEqual(run_hook("git push", self.repo), 0)

    # --- 削除系 push: ref 名を静的に確定できない難読化は fail-safe でブロック（HIGH 回帰修正） ---
    def test_push_delete_with_command_substitution_blocked(self):
        # $(echo main) はシェル実行時に main へ展開されるが、静的解析ではトークンが
        # 割れて "main" と完全一致しない -> フォールバックで許可してしまうと保護ブランチ
        # 削除の取りこぼしになるため fail-safe でブロックする。
        self.assertEqual(
            run_hook("git push origin --delete $(echo main)", self.repo), 2
        )

    def test_push_delete_with_backtick_blocked(self):
        self.assertEqual(
            run_hook("git push origin --delete `echo develop`", self.repo), 2
        )

    def test_push_delete_with_split_quote_blocked(self):
        # ma"in" はシェルが結合すると main になるが、静的には "in" のみが
        # ターゲットとして解析され保護ブランチと一致しなくなる -> fail-safe でブロック。
        self.assertEqual(
            run_hook('git push origin --delete ma"in"', self.repo), 2
        )

    def test_push_delete_non_protected_multi_branch_still_allowed(self):
        # メタ文字を含まない複数ブランチの削除は、これまでどおり誤検知なく許可される
        # （false-positive 修正の回帰確認）。
        self.assertEqual(
            run_hook(
                "git push origin --delete feat/a fix/b refactor/c", self.repo
            ),
            0,
        )

    # --- whitelist 化: blacklist 実装が取りこぼしていたケース ---
    def test_push_delete_with_backslash_blocked(self):
        # blacklist 実装（$()/`/quote のみ検査）はバックスラッシュを検査しておらず、
        # ma\in のようなトークンをすり抜けさせていた。whitelist ([A-Za-z0-9._/-]) では
        # 許容文字外のためブロックされる。
        self.assertEqual(
            run_hook(r"git push origin --delete ma\in", self.repo), 2
        )

    def test_push_delete_with_glob_blocked(self):
        # blacklist 実装は glob (*) も検査しておらず、m*in は _is_protected_ref とも
        # 完全一致しないため誤って許可されていた（実質的なバイパス）。whitelist では
        # 許容文字外のためブロックされる。
        self.assertEqual(
            run_hook("git push origin --delete m*in", self.repo), 2
        )

    def test_push_delete_protected_branch_plain_blocked(self):
        self.assertEqual(
            run_hook("git push origin --delete develop", self.repo), 2
        )

    def test_push_delete_protected_branch_with_extra_token_blocked(self):
        self.assertEqual(
            run_hook("git push origin --delete main feat/x", self.repo), 2
        )

    def test_push_delete_colon_refspec_protected_blocked(self):
        self.assertEqual(
            run_hook("git push origin :release", self.repo), 2
        )

    def test_push_delete_normal_name_with_dot_underscore_allowed(self):
        # ドット/アンダースコア/スラッシュ/ハイフンを含む正常な ref 名は whitelist を
        # 通過し、これまでどおり許可される。
        self.assertEqual(
            run_hook("git push origin --delete feat/a_b.c-d", self.repo), 0
        )

    def test_push_direct_to_protected_branch_blocked(self):
        # 削除系ではない直接 push は従来どおりブロックされる（回帰確認）。
        self.assertEqual(
            run_hook("git push origin develop", self.repo), 2
        )

    # --- heads/ プレフィックス正規化: git の DWIM 解決に合わせて保護ブランチ判定する ---
    def test_push_delete_heads_prefixed_protected_blocked(self):
        # git は heads/develop も refs/heads/develop に解決するため、旧実装
        # (refs/heads/ のみ除去) だとすり抜けて実 git 側で develop が削除されうる。
        self.assertEqual(
            run_hook("git push origin --delete heads/develop", self.repo), 2
        )

    def test_push_delete_heads_prefixed_main_blocked(self):
        self.assertEqual(
            run_hook("git push origin --delete heads/main", self.repo), 2
        )

    def test_push_delete_colon_refspec_heads_prefixed_blocked(self):
        self.assertEqual(
            run_hook("git push origin :heads/develop", self.repo), 2
        )

    def test_push_delete_refs_heads_prefixed_protected_blocked(self):
        # refs/heads/ プレフィックスの除去は旧実装から維持されていることの回帰確認。
        self.assertEqual(
            run_hook("git push origin --delete refs/heads/develop", self.repo), 2
        )

    def test_push_delete_branch_containing_heads_substring_allowed(self):
        # "heads" を含むが heads/ プレフィックスではないブランチ名は誤ブロックしない。
        self.assertEqual(
            run_hook("git push origin --delete feat/heads-up", self.repo), 0
        )

    def test_push_delete_heads_prefixed_non_protected_allowed(self):
        # heads/ を正規化した結果が非保護ブランチ名であれば引き続き許可する。
        self.assertEqual(
            run_hook("git push origin --delete heads/feature", self.repo), 0
        )

    # --- 削除ゲートは現在ブランチに依存しない（HIGH 回帰修正） ---
    # 削除判定の本質は「削除先 ref」であって「現在立っているブランチ」ではない。
    # 現在ブランチを非保護（feature/x）にした上で保護ブランチの削除を試み、
    # それでもブロックされることを確認する。
    def test_push_delete_protected_branch_blocked_from_non_protected_current_branch(self):
        _run(["git", "checkout", "-b", "feature/x"], self.repo)
        self.assertEqual(
            run_hook("git push origin --delete develop", self.repo), 2
        )

    def test_push_delete_main_blocked_from_non_protected_current_branch(self):
        _run(["git", "checkout", "-b", "feature/x"], self.repo)
        self.assertEqual(
            run_hook("git push origin --delete main", self.repo), 2
        )

    def test_push_delete_non_protected_branch_allowed_from_non_protected_current_branch(self):
        # 現在ブランチも削除対象も非保護なら、これまでどおり許可される。
        _run(["git", "checkout", "-b", "feature/x"], self.repo)
        self.assertEqual(
            run_hook("git push origin --delete feat/obsolete", self.repo), 0
        )

    def test_push_direct_to_protected_branch_allowed_from_non_protected_current_branch(self):
        # 削除系ではない直接 push は、従来どおり「現在ブランチ」で判定する
        # （現在ブランチが非保護なら push 先ブランチ名に develop を含んでいても許可）。
        _run(["git", "checkout", "-b", "feature/x"], self.repo)
        self.assertEqual(
            run_hook("git push origin develop", self.repo), 0
        )

    # --- 本丸: cd / -C で別ディレクトリに移ってから git を実行するケース ---
    def test_cd_to_feature_worktree_before_push_allowed(self):
        worktree = os.path.join(self.tmpdir, "wt-feat")
        add_worktree(self.repo, worktree, "feat")
        # hook プロセスの cwd は保護ブランチ(main)のリポのままにする
        exit_code = run_hook(f"cd {worktree} && git push -u origin feat", self.repo)
        self.assertEqual(exit_code, 0)

    def test_git_dash_c_to_feature_worktree_push_allowed(self):
        worktree = os.path.join(self.tmpdir, "wt-feat2")
        add_worktree(self.repo, worktree, "feat2")
        exit_code = run_hook(f"git -C {worktree} push", self.repo)
        self.assertEqual(exit_code, 0)

    def test_git_dash_c_to_protected_dir_blocked_even_from_nonprotected_cwd(self):
        # cwd 自体は非保護ブランチのチェックアウトだが、-C の指す先(self.repo)は
        # 保護ブランチ(main)。-C 先のブランチが正しく評価されればブロックされる
        # （cwd 側の branch だけ見ていたら誤って許可してしまう）。
        worktree = os.path.join(self.tmpdir, "wt-nonprotected")
        add_worktree(self.repo, worktree, "featC")
        exit_code = run_hook(f"git -C {self.repo} push", worktree)
        self.assertEqual(exit_code, 2)

    # --- パース規則 ---
    def test_cd_after_git_invocation_not_adopted_falls_back_to_cwd(self):
        # git push より後ろにある cd は採用しない -> cwd(=保護ブランチ)判定にフォールバック
        worktree = os.path.join(self.tmpdir, "wt-after")
        add_worktree(self.repo, worktree, "after")
        exit_code = run_hook(f"git push && cd {worktree}", self.repo)
        self.assertEqual(exit_code, 2)

    def test_last_cd_before_git_is_adopted(self):
        # A(=self.repo, protected な main) -> B(=非protectedブランチの worktree) の順に
        # cd してから push。採用されるのが最後の cd(B) であれば許可(exit 0)、
        # 最初の cd(A) やフォールバック cwd(=A) が使われていれば誤ってブロックされる(exit 2)。
        worktree_b = os.path.join(self.tmpdir, "wt-b")
        add_worktree(self.repo, worktree_b, "featB")
        exit_code = run_hook(f"cd {self.repo} && cd {worktree_b} && git push", self.repo)
        self.assertEqual(exit_code, 0)


if __name__ == "__main__":
    unittest.main()
