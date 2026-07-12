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
import subprocess
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


if __name__ == "__main__":
    unittest.main()
