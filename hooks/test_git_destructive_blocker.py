#!/usr/bin/env python3
"""git-destructive-blocker.py の契約テスト（stdlib unittest・依存追加なし）。

実行: python3 -m unittest hooks/test_git_destructive_blocker.py

hook は PreToolUse(Bash) で stdin から JSON を受け取り、保護ブランチ上での
破壊的な git 操作を exit 2 でブロックする。current_branch() は「git が実際に
走るディレクトリ」（`git -C <dir>` / 直前の `cd <dir>`）をコマンド文字列から
推定してそこで評価する（cwd 誤判定バグの修正・本ファイルの主眼）。

加えて BypassGuardTest は、git ネイティブ hook を飛ばす経路（--no-verify・core.hooksPath・
GIT_CONFIG_*・CLAUDECODE の改変など）が exit 2 で止まり、近傍の正常系・読取系が通ることを検証する。

一時リポを作る git サブプロセスは、利用者の実 git 設定（global の hooksPath や CLAUDECODE=1）の
影響を受けないよう、空の GIT_CONFIG_GLOBAL と GIT_CONFIG_NOSYSTEM=1 を渡して隔離する。
"""
import atexit
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-destructive-blocker.py")

_CFG_DIR = tempfile.mkdtemp(prefix="gdb_cfg_")
atexit.register(shutil.rmtree, _CFG_DIR, ignore_errors=True)
_EMPTY_CFG = os.path.join(_CFG_DIR, "gitconfig")
open(_EMPTY_CFG, "w").close()
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": _EMPTY_CFG, "GIT_CONFIG_NOSYSTEM": "1"}


def run_hook(command: str, cwd: str) -> int:
    """command を tool_input.command に載せて hook を cwd で起動し exit code を返す。"""
    payload = json.dumps({"tool_input": {"command": command}})
    proc = subprocess.run(
        ["python3", HOOK],
        input=payload,
        capture_output=True,
        text=True,
        cwd=cwd,
        env=GIT_ENV,
    )
    return proc.returncode


def _run(args, cwd):
    subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True, env=GIT_ENV)


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


class BypassGuardTest(unittest.TestCase):
    """git ネイティブ hook の迂回経路（文字列ガード）。cwd は非保護ブランチのリポ。"""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="gdb_bypass_")
        cls.repo = os.path.join(cls.tmpdir, "repo")
        os.makedirs(cls.repo)
        init_repo(cls.repo, "main")
        _run(["git", "checkout", "-b", "feature/x"], cls.repo)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def blocked(self, command):
        self.assertEqual(run_hook(command, self.repo), 2, command)

    def allowed(self, command):
        self.assertEqual(run_hook(command, self.repo), 0, command)

    # --- a. --no-verify / git commit -n ---
    def test_no_verify_blocked_for_commit_push_merge(self):
        self.blocked("git commit --no-verify -m x")
        self.blocked("git push --no-verify origin feature/x")
        self.blocked("git merge --no-verify topic")

    def test_no_verify_abbreviation_blocked(self):
        # git は一意な省略形 (--no-verif 等) も受け付ける
        self.blocked("git commit --no-verif -m x")

    def test_commit_short_n_blocked_alone_and_in_bundles(self):
        for flags in ("-n -m x", "-nm x", "-anm x", "-an", "-m x -n"):
            self.blocked(f"git commit {flags}")

    def test_commit_without_n_allowed(self):
        self.allowed("git commit -am x")
        self.allowed("git commit --amend --no-edit")

    def test_push_short_n_is_dry_run_allowed(self):
        self.allowed("git push -n")
        self.allowed("git push -n origin feature/x")

    def test_log_short_n_allowed(self):
        self.allowed("git log -n 5")
        self.allowed("git log --grep commit -n 5")

    # --- b. core.hooksPath / include.path ---
    def test_hookspath_via_dash_c_blocked(self):
        self.blocked("git -c core.hooksPath=/dev/null commit -m x")
        self.blocked('git -c "core.hooksPath=/dev/null" commit -m x')
        self.blocked("git -c core.hookspath=/dev/null push")

    def test_hookspath_via_config_and_config_env_blocked(self):
        self.blocked("git config core.hooksPath /dev/null")
        self.blocked("git config --unset core.hooksPath")
        self.blocked("git --config-env=core.hooksPath=EVIL commit -m x")

    def test_include_path_via_dash_c_blocked(self):
        self.blocked("git -c include.path=/tmp/evil.cfg commit -m x")

    def test_hookspath_reads_allowed(self):
        self.allowed("git config --get core.hooksPath")
        self.allowed("git config --list")
        self.allowed("git config --show-origin --get-all core.hooksPath")

    def test_hookspath_with_read_in_other_segment_still_blocked(self):
        self.blocked("git -c core.hooksPath=/dev/null commit -m x && git config --get user.name")

    def test_unrelated_config_write_allowed(self):
        self.allowed("git config user.name someone")

    # --- c. claudeguard (per-repo opt-out key) ---
    def test_claudeguard_write_blocked(self):
        self.blocked("git config claudeguard.disable true")
        self.blocked("git config --local claudeguard.disable true")
        self.blocked("git config --unset claudeguard.disable")
        self.blocked("git -c claudeguard.disable=true commit -m x")

    def test_claudeguard_read_allowed(self):
        self.allowed("git config --get claudeguard.disable")
        self.allowed("git config --local --list")

    # --- d. env tampering ---
    def test_git_config_env_vars_blocked(self):
        self.blocked("GIT_CONFIG_GLOBAL=/dev/null git commit -m x")
        self.blocked("export GIT_CONFIG_NOSYSTEM=1; git status")
        self.blocked("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x")
        self.blocked("GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\" git commit -m x")

    def test_other_git_env_vars_allowed(self):
        self.allowed("GIT_AUTHOR_NAME=someone git commit -m x")
        self.allowed("env FOO=1 git status")

    def test_claudecode_tampering_blocked(self):
        self.blocked("unset CLAUDECODE")  # git を含まないコマンドでも対象
        self.blocked("env -u CLAUDECODE git commit -m x")
        self.blocked("env --unset=CLAUDECODE git commit -m x")
        self.blocked("CLAUDECODE=0 git commit -m x")
        self.blocked("export CLAUDECODE=")

    def test_env_ignore_environment_with_git_blocked(self):
        self.blocked("env -i /usr/bin/git commit -m x")

    def test_env_prefix_with_git_interactive_flag_allowed(self):
        # env の -i (環境消去) と、git 側の -i (rebase -i / grep -i) を混同しない
        self.allowed("env GIT_SEQUENCE_EDITOR=true git rebase -i HEAD~3")
        self.allowed("env LC_ALL=C git grep -i x")

    def test_claudecode_reads_allowed(self):
        self.allowed("echo $CLAUDECODE")
        self.allowed('[ "$CLAUDECODE" = 1 ] && git status')

    # --- e. send-pack / update-ref ---
    def test_send_pack_blocked(self):
        self.blocked("git send-pack origin refs/heads/feature/x")

    def test_update_ref_on_protected_ref_blocked(self):
        self.blocked("git update-ref refs/heads/main HEAD~1")
        self.blocked("git update-ref -d refs/heads/develop")
        self.blocked("git update-ref refs/heads/release/1.0 HEAD")

    def test_update_ref_on_other_refs_allowed(self):
        self.allowed("git update-ref refs/heads/feature/x HEAD")
        self.allowed("git update-ref refs/heads/mainline HEAD")
        self.allowed("git update-ref refs/stash HEAD")

    # --- f. .git/hooks の変更 ---
    def test_mutating_git_hooks_blocked(self):
        self.blocked("rm .git/hooks/pre-commit")
        self.blocked("chmod -x .git/hooks/pre-push")
        self.blocked("mv .git/hooks/pre-push /tmp/x")
        self.blocked("ln -sf /dev/null .git/hooks/pre-commit")
        self.blocked("echo x > .git/hooks/pre-commit")
        self.blocked("echo x >> .git/hooks/pre-merge-commit")
        self.blocked("echo x | tee .git/hooks/pre-push")
        self.blocked("sed -i 's/a/b/' .git/hooks/pre-commit")
        self.blocked("rm hooks/pre-commit; git status")

    def test_reading_git_hooks_allowed(self):
        self.allowed("ls .git/hooks")
        self.allowed("ls .git/hooks 2>/dev/null")
        self.allowed("cat .git/hooks/pre-commit")
        self.allowed("head -5 .git/hooks/pre-push")
        self.allowed("grep -n x .git/hooks/pre-commit")
        self.allowed("cat .git/hooks/pre-commit > /tmp/copy_of_hook")

    def test_repo_source_hook_dir_not_confused_with_git_hooks(self):
        # git-hooks/ は hook の配布元ディレクトリ (.git/hooks ではない)
        self.allowed("cp git-hooks/pre-commit /tmp/x")

    # --- 散文 (コミットメッセージ等) の誤検知回避 ---
    def test_prose_in_commit_message_allowed(self):
        self.allowed('git commit -m "docs: explain --no-verify and core.hooksPath"')
        self.allowed("git commit -m 'explain GIT_CONFIG_GLOBAL and CLAUDECODE=0'")
        self.allowed('git commit -am "mention -n and rm .git/hooks/pre-commit"')

    def test_prose_in_quoted_heredoc_message_allowed(self):
        self.allowed(
            "git commit -m \"$(cat <<'EOF'\n"
            "docs: explain --no-verify and core.hooksPath\n\n"
            "GIT_CONFIG_GLOBAL=/dev/null and CLAUDECODE=0 are bypasses; rm .git/hooks/pre-commit\n"
            "EOF\n)\""
        )

    def test_prose_in_pr_title_and_body_allowed(self):
        self.allowed('gh pr create --title "doc git hooks" --body "explains --no-verify"')

    def test_scrub_does_not_hide_flags_after_message(self):
        self.blocked("git commit -m 'x' --no-verify")
        self.blocked("git commit -m 'x' -n")

    def test_scrub_does_not_hide_command_after_heredoc(self):
        self.blocked("git commit -F - <<'EOF'\nmsg\nEOF\ngit commit --no-verify -m y")

    def test_quoted_value_that_is_not_a_message_flag_still_scanned(self):
        self.blocked('git -c "core.hooksPath=/dev/null" commit -m x')

    def test_mention_inside_unquoted_heredoc_still_blocked_known_limit(self):
        # 既知の許容: クォート無し heredoc の本文は散文として除外しない
        self.blocked("git commit -F - <<EOF\nuse --no-verify\nEOF")

    # --- シェルコメント: 末尾コメントの --get/--list で読取扱いにならない ---
    def test_trailing_comment_does_not_make_write_a_read(self):
        self.blocked("git config core.hooksPath /dev/null # --get")
        self.blocked('git config claudeguard.protectedBranches "" # --list')
        self.blocked("git status\ngit config core.hooksPath x  #--get")
        self.blocked('git config core.hooksPath /dev/null \\" # --get \\" "')  # \" はクォートを開かない

    def test_comment_does_not_hide_following_lines(self):
        # `# <<'EOF'` はコメント。heredoc と誤認して次行を散文扱いしてはならない
        self.blocked("echo hi # <<'EOF'\ngit commit --no-verify -m x\nEOF")
        # クォートが改行をまたぐ場合も、閉じ引用符の後ろ (--no-verify) をコメント扱いしない
        self.blocked('git commit -m "a\nb #x" --no-verify')

    def test_hash_inside_quotes_or_words_is_not_a_comment(self):
        self.allowed('git commit -m "fix #123"')
        self.allowed('git log --grep="#123" --oneline')
        self.blocked('git config "core.hooksPath" "/x #y" --unset')  # クォート内の # は残る

    def test_bypass_words_inside_comment_allowed(self):
        self.allowed("git status # explains --no-verify, core.hooksPath and CLAUDECODE=0")
        self.allowed("# git config core.hooksPath /dev/null\ngit status")

    # --- CLAUDECODE の代入はコマンド境界だけ (引数内の言及は誤検知しない) ---
    def test_claudecode_assignment_at_command_boundary_blocked(self):
        for cmd in ("CLAUDECODE=0 git commit -m x", "FOO=1 CLAUDECODE=0 git commit -m x",
                    'FOO="a b" CLAUDECODE=0 git commit -m x', "echo hi; CLAUDECODE=0 git commit -m x",
                    "true && CLAUDECODE=0 git commit -m x", "echo a\nCLAUDECODE=0 git commit -m x",
                    "(CLAUDECODE=0 git commit -m x)", "{ CLAUDECODE=0 git commit -m x; }",
                    "env CLAUDECODE=0 git commit -m x", "env -u FOO CLAUDECODE=0 git commit -m x",
                    "export FOO=1 CLAUDECODE=0", "export CLAUDECODE=", "declare -x CLAUDECODE=0",
                    'bash -c "CLAUDECODE=0 git commit -m x"', "env -u CLAUDECODE git commit -m x",
                    "unset CLAUDECODE"):
            self.blocked(cmd)

    def test_claudecode_mentioned_as_argument_allowed(self):
        self.allowed('grep -rn "CLAUDECODE=1" .')
        self.allowed("echo CLAUDECODE=1")
        self.allowed("git grep -n CLAUDECODE=1")
        self.allowed("printf 'CLAUDECODE=%s' 1")
        self.allowed("ls -la; grep -c CLAUDECODE=1 notes.txt")

    # --- core.hooksPath / include.path / claudeguard は git config / -c を呼ぶセグメントだけ ---
    def test_key_mention_without_git_config_allowed(self):
        self.allowed("git grep -n core.hooksPath")
        self.allowed("grep -rn core.hooksPath git-hooks/")
        self.allowed("git grep -c claudeguard")
        self.allowed("git --no-pager grep -n include.path")
        self.allowed("git log --grep=claudeguard --oneline")
        self.allowed("git config --list | grep core.hooksPath")

    def test_git_config_without_value_is_read(self):
        self.allowed("git config core.hooksPath")
        self.allowed("git config --local core.hooksPath")
        self.allowed("git config core.hooksPath 2>/dev/null || true")
        self.allowed("git config core.hooksPath > /tmp/out")
        self.allowed("git config get core.hooksPath")
        self.allowed("git config get --all claudeguard.protectedBranches")
        self.allowed("git config list")

    def test_git_config_with_value_or_write_syntax_blocked(self):
        for cmd in ("git config core.hooksPath x", "git config core.hooksPath /dev/null",
                    "git config claudeguard.protectedBranches ''", 'git config claudeguard.protectedBranches ""',
                    "git config core.hooksPath '>'", "git config core.hooksPath > /tmp/out /dev/null",
                    "git config set core.hooksPath x", "git config unset core.hooksPath",
                    "git config --remove-section claudeguard", "git config --unset-all core.hooksPath",
                    "git -c core.hooksPath=/dev/null commit -m x", "/usr/bin/git -c core.hooksPath=/dev/null commit",
                    "git --no-pager -c claudeguard.x=1 log", "git commit --no-verify", "git commit -nm x",
                    "git send-pack origin x", "rm .git/hooks/pre-commit"):
            self.blocked(cmd)

    # --- git diff/log/show --output (任意ファイルへ書込める) ---
    def test_output_option_of_diff_log_show_blocked(self):
        self.blocked("git log --format=%s --output=/tmp/x")
        self.blocked("git diff --output=.git/hooks/pre-commit")
        self.blocked("git show --output /tmp/x HEAD")
        self.blocked("git -C . log --output=f")

    def test_similar_output_options_allowed(self):
        self.allowed("git diff --output-indicator-new=+ --output-indicator-old=-")
        self.allowed("git log --output-indicator-context=x --oneline")
        self.allowed("git log --format=%s > /tmp/out.txt")
        self.allowed("git log --oneline | tee /tmp/out.txt")

    # --- find -delete での .git/hooks 削除 ---
    def test_find_delete_in_git_hooks_blocked(self):
        self.blocked("find .git/hooks -type f -delete")
        self.blocked("find .git/hooks -exec rm {} +")
        self.allowed("find .git/hooks -type f")


if __name__ == "__main__":
    unittest.main()
