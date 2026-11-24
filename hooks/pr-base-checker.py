#!/usr/bin/env python3
"""PreToolUse(Bash): gh pr create / gh pr new の base が develop 以外ならブロックする。

ベストエフォートの文字列ガード（ADR-028: 文字列判定は既知の抜けを持つ）。--base X / --base=X /
-B X / -B=X / -BX / -dB X をすべて集め、1 つでも許可外なら、または 1 つも無ければブロックする
（最初の 1 つだけを見ると `--base develop ... --base main` が通ってしまうため）。
gh 呼び出しは 1 つずつ、自分のコマンド区切り（&& || ; | 改行。引用符内と `\` 直後は区切りでない）
までだけを見る（後続の `git checkout -B tmp` 等の -B を base と誤認しない）。各呼び出しに --base が要る。
既知の抜け: gh 呼び出し自体の引用・変数化・難読化（`"gh" pr create` 等）、引用符付きの
フラグ名（`'--base' main`）、`bash <<EOF` / `bash -c` 内の gh、`gh pr edit --base`、`gh api`。
変数経由の base（--base $X）やコメント中の --base は誤ブロック側に倒れる。
ブランチ保護の強制は git ネイティブ hook とサーバー側の branch protection が担い、本 hook は補助。

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

# `gh pr new` は `create` の別名。
GH_PR_CREATE_RE = re.compile(r'\bgh\s+pr\s+(?:create|new)\b')

# 全 base 値: --base X / --base=X / -B X / -B=X / -BX / -dB X（B で終わる短縮クラスタ）。
BASE_RE = re.compile(r'(?<![\w-])(?:--base(?:=|\s+)|-[A-Za-z]*?B(?:=|\s+)?)([^\s;&|)]+)')

# 散文の誤検出除け: heredoc 本体と、--title/--body(-t/-b) の値だけを除く（これ以上は除かない）。
# 引用符なしの値は区切り（; & |）の手前で止める（区切りまで消すと別コマンドの -B が混ざるため）。
HEREDOC_RE = re.compile(r'(?<!<)(<<-?\s*([\'"]?)(\w+)\2[^\n]*)\n.*?\n[ \t]*\3\b', re.S)
PROSE_RE = re.compile(
    r'(?<![\w-])(?:--title|--body|-t|-b)(?:=|\s+)(?:"(?:\\.|[^"\\])*"|\'[^\']*\'|[^\s;&|]+)')


# gh の引数部分: 最初のコマンド区切り（&& || ; | 改行）まで。引用符付き文字列・`\` + 1 文字・
# 単独の `&`（2>&1 等）は区切りとして扱わない。閉じない引用符は 1 文字として進む（fail-closed 側）。
SEGMENT_RE = re.compile(
    r'(?:"(?:\\.|[^"\\])*"|\'[^\']*\'|\\.|&(?!&)|[^&|;\n])*', re.S)


def strip_prose(cmd):
    return PROSE_RE.sub(' ', HEREDOC_RE.sub(r'\1', cmd))


try:
    data = json.load(sys.stdin)
    cmd = data.get('tool_input', {}).get('command', '')

    gh = GH_PR_CREATE_RE.search(cmd)
    if not gh:
        sys.exit(0)

    # 先行する git checkout -B 等を base と誤認しないよう、最初の gh pr create 以降だけを見て、
    # gh 呼び出しごとに自分のコマンド区切りまでだけから base を集める（全呼び出しを検査する）。
    rest = strip_prose(cmd[gh.start():])
    per_call, pos = [], 0
    while True:
        m = GH_PR_CREATE_RE.search(rest, pos)
        if not m:
            break
        seg = SEGMENT_RE.match(rest, m.end()).group()
        per_call.append([b.strip('\'"') for b in BASE_RE.findall(seg)])
        pos = m.end() + len(seg)
    if not all(per_call):
        # --base 指定なしの呼び出しがある（デフォルトブランチに向く可能性）
        print('⚠️  gh pr create に --base が指定されていません。')
        print('明示的に --base develop を指定してください。')
        sys.exit(2)
    bases = [b for call in per_call for b in call]

    # すべての base が許可条件を満たす必要がある。
    # 末尾コメントに vibing マーカーがある main/master のみ例外許可（ADR-015）
    marker = VIBING_MARKER_RE.search(cmd)
    bad = [b for b in bases
           if b != 'develop' and not (marker and b in VIBING_ALLOWED_BASES)]
    if bad:
        print(f'🔴 PR の base が "{bad[0]}" になっています。base は "develop" のみ許可されます。')
        print('main / master への PR は禁止です（vibing は所定のマーカー付きのみ例外）。')
        sys.exit(2)
    sys.exit(0)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
