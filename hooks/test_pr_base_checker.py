#!/usr/bin/env python3
"""pr-base-checker.py の契約テスト（stdlib unittest・依存追加なし）。

実行: python3 -m unittest hooks/test_pr_base_checker.py
      （または python3 hooks/test_pr_base_checker.py）

hook は PreToolUse(Bash) で stdin から JSON を受け取り、
`gh pr create` の --base が許可されていなければ exit 2 でブロックする。
develop は常に許可。**末尾コメント**に vibing マーカー(`__VIBING_AUTORUN_PR__`)を持つ
main/master のみ例外的に許可（ADR-015）。マーカーが title/body 等に紛れても許可しない。
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pr-base-checker.py")
MARKER = "__VIBING_AUTORUN_PR__"


def run_hook(command: str) -> int:
    """command を tool_input.command に載せて hook を起動し exit code を返す。"""
    payload = json.dumps({"tool_input": {"command": command}})
    proc = subprocess.run(
        ["python3", HOOK],
        input=payload,
        capture_output=True,
        text=True,
    )
    return proc.returncode


class PrBaseCheckerTest(unittest.TestCase):
    # --- 従来挙動（回帰） ---
    def test_develop_base_allowed(self):
        self.assertEqual(run_hook("gh pr create --base develop --title x"), 0)

    def test_main_base_without_marker_blocked(self):
        self.assertEqual(run_hook("gh pr create --base main --title x"), 2)

    def test_non_develop_base_without_marker_blocked(self):
        self.assertEqual(run_hook("gh pr create --base staging --title x"), 2)

    def test_missing_base_blocked(self):
        self.assertEqual(run_hook("gh pr create --title x"), 2)

    def test_non_pr_command_passthrough(self):
        self.assertEqual(run_hook("git status"), 0)

    # --- vibing マーカー例外（ADR-015・末尾コメント位置のみ） ---
    def test_main_base_with_trailing_marker_allowed(self):
        self.assertEqual(run_hook(f"gh pr create --base main --title x  # {MARKER}"), 0)

    def test_master_base_with_trailing_marker_allowed(self):
        self.assertEqual(run_hook(f"gh pr create --base master --title x  # {MARKER}"), 0)

    def test_quoted_main_base_with_marker_allowed(self):
        # --base "main"（クォート付き）でもマーカー末尾なら許可
        self.assertEqual(run_hook(f'gh pr create --base "main" --title x  # {MARKER}'), 0)

    def test_marker_does_not_whitelist_arbitrary_base(self):
        # マーカーが付いても main/master 以外は通さない（fail-closed）
        self.assertEqual(run_hook(f"gh pr create --base staging --title x  # {MARKER}"), 2)

    # --- fail-open 回帰: マーカーが末尾コメント以外に現れても許可しない ---
    def test_marker_in_title_blocked(self):
        self.assertEqual(run_hook(f'gh pr create --base main --title "explain {MARKER} mode"'), 2)

    def test_marker_in_body_blocked(self):
        self.assertEqual(run_hook(f'gh pr create --base main --body "see {MARKER}" --title x'), 2)

    def test_marker_not_at_end_blocked(self):
        # 末尾コメントの後にさらにトークンが続けば許可しない（アンカー外）
        self.assertEqual(run_hook(f"gh pr create --base main --title x  # {MARKER} extra"), 2)

    def test_quoted_main_base_without_marker_blocked(self):
        self.assertEqual(run_hook('gh pr create --base "main" --title x'), 2)

    # --- 複数 base: すべての base が許可条件を満たす必要がある（最初の 1 つだけ見ない） ---
    def test_multi_base_long_develop_then_main_blocked(self):
        self.assertEqual(run_hook("gh pr create --base develop --title x --base main"), 2)

    def test_multi_base_short_develop_then_main_blocked(self):
        self.assertEqual(run_hook("gh pr create -B develop -B main --title x"), 2)

    def test_multi_base_equals_form_blocked(self):
        self.assertEqual(run_hook("gh pr create --base=develop --base=main"), 2)

    def test_multi_base_main_then_develop_blocked(self):
        self.assertEqual(run_hook("gh pr create --base main --base develop"), 2)

    def test_multi_base_all_develop_allowed(self):
        self.assertEqual(run_hook("gh pr create --base develop -B develop --title x"), 0)

    def test_multi_base_main_with_marker_allowed(self):
        # マーカー付きなら main は許可条件を満たす（develop と併記でも全 base が通る）
        self.assertEqual(run_hook(f"gh pr create --base develop -B main  # {MARKER}"), 0)

    def test_multi_base_main_without_marker_blocked(self):
        self.assertEqual(run_hook("gh pr create --base develop -B main"), 2)

    def test_multi_base_marker_does_not_cover_other_base(self):
        self.assertEqual(run_hook(f"gh pr create -B main --base staging  # {MARKER}"), 2)

    # --- base の書式 ---
    def test_short_B_forms(self):
        for cmd, want in [
            ("gh pr create -B develop", 0),
            ("gh pr create -B main", 2),
            ("gh pr create -Bdevelop", 0),
            ("gh pr create -Bmain", 2),
            ("gh pr create -B=develop", 0),
            ("gh pr create -B=main", 2),
            ("gh pr create -dB develop", 0),
            ("gh pr create -dB main", 2),
            ("gh pr create -dBmain", 2),
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(run_hook(cmd), want)

    def test_equals_form(self):
        self.assertEqual(run_hook("gh pr create --base=develop"), 0)
        self.assertEqual(run_hook("gh pr create --base=main"), 2)

    def test_base_before_shell_operator_allowed(self):
        self.assertEqual(run_hook("gh pr create --base develop && echo done"), 0)
        self.assertEqual(run_hook("(gh pr create --base develop)"), 0)

    # --- gh pr new は create の別名 ---
    def test_pr_new_main_blocked(self):
        self.assertEqual(run_hook("gh pr new --base main"), 2)

    def test_pr_new_develop_allowed(self):
        self.assertEqual(run_hook("gh pr new --base develop"), 0)

    def test_pr_new_without_base_blocked(self):
        self.assertEqual(run_hook("gh pr new --title x"), 2)

    # --- 散文（title/body/heredoc）中の --base は base と数えない ---
    def test_prose_in_body_ignored(self):
        self.assertEqual(
            run_hook('gh pr create --base develop --body "see --base main for hotfixes"'), 0)
        self.assertEqual(
            run_hook("gh pr create --base develop -b 'use -B main for hotfixes' -t x"), 0)

    def test_prose_in_title_ignored(self):
        self.assertEqual(run_hook('gh pr create -t "doc --base main" --base develop'), 0)

    def test_heredoc_body_ignored(self):
        cmd = ("gh pr create --base develop --title x --body \"$(cat <<'EOF'\n"
               "Hotfixes go with --base main.\n-B main too, \"quoted\" and `code`\nEOF\n)\"")
        self.assertEqual(run_hook(cmd), 0)

    def test_preceding_git_B_flag_not_a_base(self):
        # gh pr create より前の git checkout -B / grep -B を base と誤認しない
        self.assertEqual(
            run_hook("git checkout -B topic && git push -u origin topic && "
                     "gh pr create --base develop"), 0)
        self.assertEqual(run_hook("grep -B 3 foo f; gh pr create --base develop"), 0)

    def test_heredoc_does_not_hide_real_base(self):
        cmd = ("gh pr create --title x --body \"$(cat <<'EOF'\n--base develop\nEOF\n)\" "
               "--base main")
        self.assertEqual(run_hook(cmd), 2)

    def test_prose_scrub_does_not_hide_real_base(self):
        self.assertEqual(run_hook('gh pr create --body "x" --base main'), 2)
        # 閉じ引用符が無ければ除去されず fail-closed
        self.assertEqual(run_hook('gh pr create --title "oops --base main'), 2)

    def test_command_substitution_in_head_allowed(self):
        cmd = 'gh pr create --head "$(git branch --show-current)" --base develop'
        self.assertEqual(run_hook(cmd), 0)

    # --- create 以外の gh pr サブコマンドは対象外 ---
    def test_other_pr_subcommands_passthrough(self):
        for cmd in ["gh pr view 3", "gh pr list --base main", "gh pr edit 3 --base main"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(run_hook(cmd), 0)

    # --- gh 呼び出しごとにコマンド区切りまでだけを見る（後続コマンドの -B を base と誤認しない） ---
    def test_following_git_B_flag_not_a_base(self):
        for cmd in [
            "gh pr create --base develop --fill && git checkout -B tmp",
            "gh pr create --base develop; git checkout -B tmp",
            "gh pr create --base develop || git checkout -B tmp",
            "gh pr create --base develop\ngit checkout -B tmp",
            "gh pr create --base develop ; foo --base main",
            "gh pr create -B develop | tee out",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(run_hook(cmd), 0)

    def test_following_command_base_does_not_satisfy_missing_base(self):
        # 区切りの後の -B develop は git のもの。gh 側に base が無いのでブロック。
        self.assertEqual(run_hook("gh pr create --title x; git checkout -B develop"), 2)
        self.assertEqual(run_hook("gh pr create && git checkout -B develop"), 2)

    def test_every_invocation_checked_separately(self):
        for cmd, want in [
            ("gh pr create --base develop && gh pr create --base main", 2),
            ("gh pr create --base main && gh pr create --base develop", 2),
            ("gh pr create --base develop; gh pr new -B main", 2),
            ("gh pr create --base develop || gh pr create --base develop", 0),
            ("gh pr create --base develop && gh pr create --fill", 2),
            ("gh pr create --base develop --base main && echo ok", 2),
            ("gh pr create --base develop --base main", 2),
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(run_hook(cmd), want)

    def test_marker_covers_every_invocation(self):
        cmd = f"gh pr create --base main && gh pr create --base develop  # {MARKER}"
        self.assertEqual(run_hook(cmd), 0)

    def test_backslash_continuation_is_not_a_separator(self):
        self.assertEqual(run_hook("gh pr create \\\n  --base develop \\\n  --title x"), 0)
        self.assertEqual(run_hook("gh pr create \\\n  --base main \\\n  --title x"), 2)

    def test_quoted_or_redirect_separator_does_not_cut(self):
        for cmd, want in [
            ('gh pr create --base develop --head "a;b" --base main', 2),
            ('gh pr create --head "$(git rev-parse HEAD | cut -c1-8)" --base main', 2),
            ('gh pr create --head "$(git rev-parse HEAD | cut -c1-8)" --base develop', 0),
            ("gh pr create --base develop 2>&1 --base main", 2),
            ("gh pr create --base develop 2>&1 | tee out", 0),
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(run_hook(cmd), want)

    def test_heredoc_body_then_following_command(self):
        head = ("gh pr create --base develop --title x --body \"$(cat <<'EOF'\n"
                "Hotfixes go with gh pr create --base main and -B main.\nEOF\n)\"")
        self.assertEqual(run_hook(head), 0)
        self.assertEqual(run_hook(head + " && git checkout -B tmp"), 0)
        self.assertEqual(run_hook(head + " && gh pr create --base main"), 2)

    def test_prose_mentioning_gh_pr_create_ignored(self):
        cmd = 'gh pr create --base develop --body "run gh pr create --base main later"'
        self.assertEqual(run_hook(cmd), 0)


class ProjectPrBasesTest(unittest.TestCase):
    """`<project>/.claude/pr-bases.json` の追加許可。hook を <tmp>/.claude/hooks/ に複製して起動する
    （場所は hook 自身の位置から決まり、cwd では決まらないため、cwd は無関係な場所にする）。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.claude = os.path.join(tmp.name, ".claude")
        hooks = os.path.join(self.claude, "hooks")
        os.makedirs(hooks)
        self.hook = os.path.join(hooks, "pr-base-checker.py")
        shutil.copy(HOOK, self.hook)
        self.cwd = tempfile.mkdtemp(dir=tmp.name)

    def run_in_project(self, command: str) -> int:
        proc = subprocess.run(
            ["python3", self.hook],
            input=json.dumps({"tool_input": {"command": command}}),
            capture_output=True, text=True, cwd=self.cwd,
        )
        return proc.returncode

    def write_bases(self, text: str):
        with open(os.path.join(self.claude, "pr-bases.json"), "w", encoding="utf-8") as f:
            f.write(text)

    def test_no_file_keeps_develop_only(self):
        self.assertEqual(self.run_in_project("gh pr create --base main"), 2)
        self.assertEqual(self.run_in_project("gh pr create --base develop"), 0)

    def test_allow_main_permits_main_only(self):
        self.write_bases('{"allow": ["main"]}')
        self.assertEqual(self.run_in_project("gh pr create --base main"), 0)
        self.assertEqual(self.run_in_project("gh pr create --base master"), 2)
        self.assertEqual(self.run_in_project("gh pr create --base develop"), 0)

    def test_every_base_must_be_allowed(self):
        self.write_bases('{"allow": ["main"]}')
        self.assertEqual(self.run_in_project("gh pr create --base main --base master"), 2)
        self.assertEqual(self.run_in_project("gh pr create --base develop -B main"), 0)

    def test_bad_file_never_widens(self):
        for text in ['{not json', '{"allow": "main"}', '{"allow": {"main": 1}}',
                     '["main"]', '{"allow": [["main"]]}', '{"allow": [null, 1]}', '']:
            with self.subTest(text=text):
                self.write_bases(text)
                self.assertEqual(self.run_in_project("gh pr create --base main"), 2)
                self.assertEqual(self.run_in_project("gh pr create --base develop"), 0)

    def test_string_allow_does_not_allow_its_characters(self):
        self.write_bases('{"allow": "main"}')
        self.assertEqual(self.run_in_project("gh pr create --base m"), 2)

    def test_weird_names_are_ignored(self):
        self.write_bases('{"allow": ["main; rm", "ma in", "main\\n", "$(x)", ""]}')
        for base in ["main", "'main; rm'", "ma"]:
            with self.subTest(base=base):
                self.assertEqual(self.run_in_project(f"gh pr create --base {base}"), 2)

    def test_valid_name_next_to_weird_one_still_works(self):
        self.write_bases('{"allow": ["main; rm", "release/1.x"]}')
        self.assertEqual(self.run_in_project("gh pr create --base release/1.x"), 0)
        self.assertEqual(self.run_in_project("gh pr create --base main"), 2)

    def test_file_is_found_from_the_hook_location_not_cwd(self):
        # cwd 側（<cwd>/.claude/pr-bases.json）に置いても効かない
        os.makedirs(os.path.join(self.cwd, ".claude"))
        with open(os.path.join(self.cwd, ".claude", "pr-bases.json"), "w") as f:
            f.write('{"allow": ["main"]}')
        self.assertEqual(self.run_in_project("gh pr create --base main"), 2)

    def test_vibing_marker_still_works_with_file(self):
        self.write_bases('{"allow": ["staging"]}')
        self.assertEqual(self.run_in_project(f"gh pr create --base main  # {MARKER}"), 0)
        self.assertEqual(self.run_in_project(f"gh pr create --base other  # {MARKER}"), 2)


if __name__ == "__main__":
    unittest.main()
