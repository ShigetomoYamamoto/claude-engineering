#!/usr/bin/env python3
"""PreToolUse(Bash): gh pr create の base が develop 以外ならブロックする。

例外（ADR-015 / vibing）: コマンド文字列の **末尾シェルコメント**に vibing マーカー
（VIBING_MARKER）が置かれている場合に限り、base が main / master の PR を許可する。
それ以外（マーカー無しの非 develop base・マーカー付きでも main/master 以外・マーカーが
末尾コメント以外の位置＝--title/--body 等に現れただけ）は従来どおりブロック（fail-closed）。
マーカーをコマンド文字列に置くのは、hook が tool_input.command しか受け取らず
環境変数を確実に読めないため（autorun は別サブシェルで gh を起動する）。
末尾コメント位置にアンカーするのは、公開済みのモード名が PR の title/body に
紛れただけでガードが無効化される事故（部分一致 fail-open）を防ぐため。
"""
import json, sys, re

# vibing が PR→main を出すときだけコマンド末尾コメントに付与する名前空間付きトークン。
# 通常の散文・PR title/body には現れない値とし、vibing 以外はこれを発行しない（ADR-015）。
VIBING_MARKER = '__VIBING_AUTORUN_PR__'

# 末尾シェルコメント `... # __VIBING_AUTORUN_PR__` の位置にのみ一致させる（部分一致を禁止）。
VIBING_MARKER_RE = re.compile(r'#\s*' + re.escape(VIBING_MARKER) + r'\s*$')

# マーカー付きで例外的に許可する base（develop は常に許可なので含めない）。
VIBING_ALLOWED_BASES = {'main', 'master'}

try:
    data = json.load(sys.stdin)
    cmd = data.get('tool_input', {}).get('command', '')

    if not cmd or 'gh pr create' not in cmd:
        sys.exit(0)

    # --base <branch> を抽出
    m = re.search(r'--base[=\s]+([^\s]+)', cmd)
    if m:
        base = m.group(1).strip("'\"")
        if base == 'develop':
            sys.exit(0)
        # 末尾コメントに vibing マーカーがある main/master のみ例外許可（ADR-015）
        if base in VIBING_ALLOWED_BASES and VIBING_MARKER_RE.search(cmd):
            sys.exit(0)
        print(f'🔴 PR の base が "{base}" になっています。base は "develop" のみ許可されます。')
        print('main / master への PR は禁止です（vibing は所定のマーカー付きのみ例外）。')
        sys.exit(2)
    else:
        # --base 指定なし（デフォルトブランチに向く可能性）
        print('⚠️  gh pr create に --base が指定されていません。')
        print('明示的に --base develop を指定してください。')
        sys.exit(2)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
