#!/usr/bin/env python3
"""PreToolUse(Edit|Write|MultiEdit): 保護されたブランチ上でのファイル編集をブロックする。
main/master は常に保護対象。develop 等の git-flow ブランチは、それらが実際に存在する
（= git-flow 運用中と検出された）プロジェクトのみ追加で保護対象とする。

判定は cwd ではなく編集対象 file_path の所在で行う。cwd が保護ブランチのリポでも、
file_path がそのリポ外（git 管理外ファイルや別 worktree）であれば無関係なので許可
する。file_path が欠落／相対で解決不能な場合のみ、従来の cwd 判定にフォールバック
する（fail-safe）。"""
import json, sys, re, subprocess, os

# main/master は SECONDARY の存在有無に関わらず常に保護対象（trunk-based / git-flow を
# 問わない）。develop 等は、実際にそのブランチ名が存在する（= git-flow 運用中と検出
# された）場合のみ追加で保護対象とする。
ALWAYS_PROTECTED = {'main', 'master'}

SECONDARY = {'develop', 'development', 'staging', 'release', 'production', 'prod', 'trunk'}

PROTECTED = ALWAYS_PROTECTED | SECONDARY


def run_git(args, dir_path):
    """dir_path があれば `git -C <dir_path>`、無ければプロセス cwd で git を実行する。"""
    cmd = ['git']
    if dir_path:
        cmd += ['-C', dir_path]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=5)


try:
    data = json.load(sys.stdin)
    file_path = (
        data.get('tool_input', {}).get('file_path')
        or data.get('tool_input', {}).get('path', '')
    )
except Exception:
    file_path = ''

# file_path が絶対パスで得られた場合のみ、その所在ディレクトリで判定する。
# 欠落・相対（cwd 抜きでは解決不能）なら None＝従来の cwd 判定にフォールバックする。
target_dir = os.path.dirname(file_path) if file_path and os.path.isabs(file_path) else None

try:
    r = run_git(['rev-parse', '--is-inside-work-tree'], target_dir)
    if r.returncode != 0:
        sys.exit(0)
except Exception:
    sys.exit(0)

try:
    r = run_git(['branch', '--show-current'], target_dir)
    current = r.stdout.strip()
except Exception:
    sys.exit(0)

if current not in PROTECTED:
    sys.exit(0)

# main/master はここで無条件に保護対象として扱いを続ける（下の SECONDARY 存在
# チェックをスキップする）。develop 等はこれまで通り、実際に SECONDARY ブランチが
# 存在する場合のみ保護対象とする。
if current not in ALWAYS_PROTECTED:
    try:
        all_r = run_git(['branch', '-a'], target_dir)
        existing = set(re.findall(r'\b\w+\b', all_r.stdout))
        if not (SECONDARY & existing):
            sys.exit(0)
    except Exception:
        sys.exit(0)

print(f'🔴 保護されたブランチ "{current}" 上でファイルを編集しようとしています。')
print(f'  対象ファイル: {file_path}')
print('作業ブランチを作成してから実装を開始してください。')
print('  /create-branch を使用するか:')
print('  git checkout -b <prefix>/<summary>_YYYYMMDD')
sys.exit(2)
