#!/usr/bin/env python3
"""PreToolUse(Bash): git commit のメッセージが Conventional Commits 形式かを検査する。

公式の薄い commit コマンド（commit-commands プラグイン等）に寄せても日本語
Conventional Commits 規約を保つための parity hook。安全装置ではなく規約チェック。

判定方針（誤検知で作業を止めない＝fail open を優先）:
- git commit 以外、メッセージを静的に読めない呼び出し（エディタ起動・コマンド置換・
  heredoc・--amend で本文なし 等）は exit 0 で通す。
- 読めたメッセージの件名行が type プレフィックス（または Merge/Revert/fixup/squash）
  に従わないときだけ exit 2 でブロックする。
"""
import json, os, re, sys

TYPES = ('feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci', 'build', 'style', 'revert')
# 件名: "type: 説明" / "type(scope): 説明" / "type!: 説明"（破壊的変更）
SUBJECT_RE = re.compile(rf'^(?:{"|".join(TYPES)})(?:\([^)]+\))?!?: .+')
# git が自動生成する件名や rebase 系は規約対象外
EXEMPT_PREFIX_RE = re.compile(r'^(Merge |Revert |fixup! |squash! |amend! )')
# 静的に解決できない（＝中身を読めない）メッセージ指定
UNRESOLVABLE_RE = re.compile(r'\$\(|`|<<')


def is_git_commit(cmd):
    """git commit がシェル演算子の直後か行頭にある（実際に実行される）か。"""
    pattern = r'(?:^|&&|\|\||;|\n)\s*(?:\S+\s+)*git\s+commit\b'
    return bool(re.search(pattern, cmd, re.MULTILINE))


def extract_subject(cmd):
    """commit メッセージの件名（先頭行）を返す。読めない場合は None。"""
    # -F / --file <path>: ファイル先頭の非空行を件名とする
    fm = re.search(r'(?:-F|--file)[=\s]+(\'[^\']+\'|"[^"]+"|\S+)', cmd)
    if fm:
        path = fm.group(1).strip('\'"')
        try:
            with open(path, encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        return line.strip()
        except Exception:
            return None
        return None

    # -m / --message <msg>
    mm = re.search(r'(?:-m|--message)[=\s]+(\'[^\']*\'|"[^"]*"|\S+)', cmd)
    if mm:
        raw = mm.group(1)
        # コマンド置換・heredoc・バッククォートは静的に読めない → 対象外
        if UNRESOLVABLE_RE.search(raw):
            return None
        return raw.strip('\'"').splitlines()[0].strip() if raw.strip('\'"') else None

    # -m が無い（エディタ起動など）→ 読めない
    return None


try:
    data = json.load(sys.stdin)
    cmd = data.get('tool_input', {}).get('command', '')

    if not cmd or not is_git_commit(cmd):
        sys.exit(0)

    # メッセージを伴わない commit（--amend の本文維持・エディタ起動等）は対象外
    if not re.search(r'(?:-m|--message|-F|--file)\b', cmd):
        sys.exit(0)

    subject = extract_subject(cmd)
    if subject is None:
        sys.exit(0)  # 静的に読めない → fail open

    if EXEMPT_PREFIX_RE.match(subject) or SUBJECT_RE.match(subject):
        sys.exit(0)

    print(f'🔴 コミットメッセージが Conventional Commits 形式ではありません。')
    print(f'  件名: {subject}')
    print('  形式: <type>: <日本語の説明>  （例: "fix: ログイン時の null 参照を修正"）')
    print(f'  type: {", ".join(TYPES)}')
    print('  詳細は ~/.claude/skills/git-workflow/SKILL.md を参照。')
    sys.exit(2)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
