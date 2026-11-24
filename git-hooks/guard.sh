#!/bin/sh
# claude-engineering:guard v1
# Git-native guard (see git-hooks/README.md). install.py copies this file, byte for byte, to
# <git common dir>/hooks/{pre-commit,pre-merge-commit,pre-push}; the hook name is basename "$0".
# It acts ONLY when CLAUDECODE=1 (Claude Code sets it in the shells it spawns): a human's
# terminal is never affected. On a protected branch it blocks
#   pre-commit, pre-merge-commit : the commit (detached HEAD and the first commit of an unborn HEAD pass)
#   pre-push                     : any push whose remote ref is refs/heads/<protected> (update, force, delete)
# Protected branches: `git config claudeguard.protectedBranches` (space-separated shell globs;
# unset = default list below, empty = disabled). Fail-safe: an unexpected error in THIS script
# warns on stderr and exits 0; it never blocks by accident.

[ "${CLAUDECODE:-}" = 1 ] || exit 0

set -f # $pats is expanded unquoted below: never glob it against the filesystem
hook=${0##*/}
# The names protected by hooks/git-destructive-blocker.py; "<name>/*" mirrors its prefix match on delete.
DEFAULT_PROTECTED='main main/* master master/* develop develop/* development development/*
 staging staging/* release release/* production production/* prod prod/* trunk trunk/*'

warn() { echo "[claudeguard] 警告: ガード処理で想定外のエラー ($1)。ブロックせず続行します。" >&2; }

load_patterns() { # exit status of `git config --get`: 0 = value (may be empty), 1 = unset, other = error
  pats=$(git config --get claudeguard.protectedBranches 2>/dev/null)
  case $? in 0) ;; 1) pats=$DEFAULT_PROTECTED ;; *) warn config; exit 0 ;; esac
}

protected() { # $1 = short branch name
  for p in $pats; do
    case $1 in $p) return 0 ;; esac
  done
  return 1
}

block() { # $1 = the branch or ref that must not be updated
  cat >&2 <<EOF
[claudeguard] 保護ブランチの更新を止めました ($hook): $1
理由: AI エージェントが保護ブランチを直接更新するのを防ぐため (CLAUDECODE=1 のときだけ有効)。
対処: 作業ブランチを作成し (例: git switch -c <prefix>/<summary>_YYYYMMDD)、そこで作業して PR 経由で取り込んでください。
EOF
  exit 1
}

case $hook in
  pre-commit | pre-merge-commit)
    # full ref, not --short: with a tag of the same name, --short prints "heads/main" and the match would be missed
    ref=$(git symbolic-ref --quiet HEAD 2>/dev/null) || { [ $? -eq 1 ] || warn symbolic-ref; exit 0; } # detached: allow
    br=${ref#refs/heads/}
    git rev-parse --verify --quiet HEAD >/dev/null 2>&1 || { [ $? -eq 1 ] || warn rev-parse; exit 0; } # unborn: allow
    load_patterns
    protected "$br" && block "$br"
    ;;
  pre-push) # stdin: "<local ref> <local sha> <remote ref> <remote sha>" per line
    load_patterns
    while read -r _ _ rref _; do
      case $rref in refs/heads/*) protected "${rref#refs/heads/}" && block "$rref" ;; esac
    done
    ;;
esac
exit 0
