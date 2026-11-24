#!/usr/bin/env python3
"""PreToolUse(Bash): git の破壊的操作と、git ネイティブ hook の迂回経路をブロックする。

役割: 保護ブランチへの commit/push 禁止の本体は git ネイティブ hook (リポジトリ毎に導入・
CLAUDECODE=1 のときだけ作用)。本 hook はその補完で、hook を飛ばす経路を文字列照合で止める
ベストエフォートの文字列ガード (不完全と承知の上で、トークナイザ/シェル模擬はしない)。
迂回経路のブロック: (a) --no-verify (省略形 --no-veri 以降も) / git commit -n (b) core.hooksPath・
include.path の設定 (c) claudeguard の書換 (d) GIT_CONFIG_* / CLAUDECODE の改変 (env -i も)
(e) git send-pack・保護 ref への update-ref (f) .git/hooks の変更 (find -delete 含む)
(g) git diff/log/show の --output (任意ファイルへ書込める) (h) push/fetch/pull/ls-remote/clone/archive の
--upload-pack・--receive-pack・--exec (省略形・clone -u・fetch-pack・upload-archive も。任意プログラムを実行できる)
と git --exec-path=<dir>。(h) は引用符・\\ を除いて照合し、fetch 等の後ろの旗の値 (-t "--upload-pack=x") は除かない
(i) curl / wget の出力先 (-o・--output・-O 等) が .git/・.claude/ 配下 (保護対象のファイルを curl で上書きする経路)。
(a)(f)(g) も引用符・\\ を除いた版で照合する ("--no-ver""ify" 等の分割対策)。
読取 (--get/--list・get/list 構文・値引数の無い `git config <key>`) は許可。(b)(c) は git config / -c / --config-env
を実際に呼ぶセグメントだけが対象。CLAUDECODE の代入は文頭・; & | ( の直後・export/env 等の後だけ見る。
散文の誤検知対策: シェルコメント、クォート付き heredoc の本文、-m/--message/--body/-b/--title/-t の
クォート値は照合前に除く。クォート無し heredoc 内などでの言及は誤ブロックしうる (許容)。
既知の限界: alias・変数経由・python -c での組立て・クォート付き heredoc を shell へ流す形
(bash <<'EOF')・コマンド置換入りの -m 値・--git-dir/GIT_DIR の差替え・xargs 等でパイプから渡す
config 値・Bash/Edit/Write での .git/config や hook の直接編集は検知できない。"""
import json, sys, re, subprocess

PROTECTED = (
    'main', 'master',           # GitHub/Git デフォルトブランチ
    'develop', 'development',   # Git Flow 開発ブランチ
    'staging',                  # ステージング環境
    'release',                  # リリースブランチ
    'production', 'prod',       # 本番環境
    'trunk',                    # Trunk-based development
)

def _strip_quotes(s):
    return s.strip('\'"')

def resolve_git_dir(cmd):
    """cmd 文字列から「git が実際に走るディレクトリ」を推定する。
    (1) `git -C <dir>` があればその <dir>。
    (2) 無ければ、最初の git 実行箇所より前に現れる最後の `cd <dir>`。
    (3) どちらも無ければ None（呼び出し側はプロセス cwd にフォールバックする）。
    push 先ブランチの評価は行わない（スコープ外）。「保護ブランチ上に居るか」を
    評価する場所を cwd から正しいディレクトリへ正すだけ。"""
    m = re.search(r'\bgit\s+-C\s+(\S+)', cmd)
    if m:
        return _strip_quotes(m.group(1))

    invocation = re.search(r'(?:^|&&|\|\||;|\n)\s*(?:\S+\s+)*(git\s+\S+)', cmd, re.MULTILINE)
    if not invocation:
        return None

    prefix = cmd[:invocation.start(1)]
    cd_matches = list(re.finditer(r'\bcd\s+(\S+)', prefix))
    if not cd_matches:
        return None
    return _strip_quotes(cd_matches[-1].group(1))

def current_branch(cmd=''):
    """cmd から推定した実行ディレクトリ（無ければプロセス cwd）でカレントブランチを返す。
    判定不能・git 失敗時は空文字を返し、PROTECTED 非該当＝許可という従来挙動を保つ。"""
    git_dir = resolve_git_dir(cmd) if cmd else None
    try:
        base = ['git']
        if git_dir:
            base += ['-C', git_dir]
        base += ['branch', '--show-current']
        r = subprocess.run(base, capture_output=True, text=True, timeout=5)
        return r.stdout.strip()
    except Exception:
        return ''

def is_git_invocation(cmd, subcmd):
    """git <subcmd> がシェル演算子の直後か行頭にある（実際に実行される）か判定する。
    grep/echo/python -c 等の引数内に含まれる場合は除外する。`git -C <dir> <subcmd>`
    のように git と subcmd の間に -C <dir> が挟まる形も subcmd の実行として認識する。"""
    pattern = rf'(?:^|&&|\|\||;|\n)\s*(?:\S+\s+)*git\s+(?:-C\s+\S+\s+)?{re.escape(subcmd)}\b'
    return bool(re.search(pattern, cmd, re.MULTILINE))

_OPTS = r'(?:\s+-\S+(?:\s+[^-\s]\S*)?)*'  # git のグローバルオプション列 (-C <dir> / -c <kv> 等)

def _sub(name):
    """`git [グローバルopt...] <name>` (または git-<name>) にマッチする正規表現。"""
    return rf'\bgit(?:-|{_OPTS}\s+){name}\b'

# git config を実際に呼ぶ形: `git config` か、グローバルオプションの -c / --config-env
_CFG = _sub('config') + rf'|\bgit{_OPTS}\s+(?:-c|--config-env)\b'
# CLAUDECODE の代入が成立する位置: コマンド境界 / export・env 等の直後 / sh -c "..." の先頭
# (grep・echo の引数や引用符内の CLAUDECODE=1 は代入ではない)。値のクォートは互いに素にして線形時間に保つ。
_VAL = r'''(?:[^\s"']|"[^"]*"|'[^']*')*'''
_CC = (r'(?:^|[;&|(`]|\{\s|\b(?:export|declare|typeset|readonly|env|time|nohup|exec|command|sudo|then|do|else)\s'
       r'|\b(?:(?:ba|z|da|k)?sh\s+-\w+|eval)\s+["\']?)\s*(?:-\S+\s+(?:[^\s=-][^\s=]*\s+)?)*'
       rf'(?:\w+={_VAL}\s+)*CLAUDECODE\+?=')

# 任意プログラムを実行するリモートヘルパーのオプション。git は曖昧でない省略形も受理する
# (実測: push --e/--exe、fetch --upl、ls-remote --u、push --rece 等) ので、接頭辞をすべて照合する。
# --exec-path は別物 (接頭辞にならない) なので `(?![\w-])` で外れる。
_RP_NAMES = ('upload-pack', 'receive-pack', 'exec')
_RP_OPT = (r'(?<![\w-])--(?:' + '|'.join(sorted({n[:i] for n in _RP_NAMES for i in range(1, len(n) + 1)},
           key=len, reverse=True)) + r')(?![\w-])')
_RP_CMDS = '(?:push|fetch-pack|fetch|pull|ls-remote|clone|archive|upload-archive)'
_DL = {'curl': (('output', 'output-dir'), 'o'), 'wget': (('output-document', 'directory-prefix'), 'OP')}  # 長い名前は接頭辞も照合
_PROT_PATH = re.compile(r'(?:^|/)\.(?:git|claude)(?:/|$)', re.I)  # 出力先が保護対象か (macOS は大小無視のFS)

def strip_comments(s):
    """行頭または空白直後の # から行末までを除く。クォート (改行をまたぐ) と \\x の中の # は残す。"""
    return re.sub(r'''(\\.|"(?:[^"\\]|\\.)*"|'[^']*')|(?:^|(?<=\s))#[^\n]*''',
                  lambda m: m.group(1) or '', s, flags=re.M | re.S)

def scrub_prose(cmd, keep_rp=False):
    """照合前に散文を除く: クォート付き heredoc の本文と、-m 等のクォート値 (旗は残す)。keep_rp=True は
    同じセグメントの手前に push/fetch 等がある旗の値は残す (fetch/ls-remote の -t/-m/-b は真偽値の旗)。"""
    cmd = cmd.replace('\\\n', ' ')
    cmd = re.sub(r'(?<!<)(<<-?\s*([\'"])(\w+)\2[^\n]*\n).*?^[ \t]*\3[ \t]*$', r'\1\3', cmd, flags=re.S | re.M)
    st = [0, False]  # [直前の旗の終端, 同じセグメントの手前に push/fetch 等があるか] (旗どうしの間の文だけ見て線形時間)
    def val(m):
        parts = re.split(r'[;&|\n]', re.sub(r'["\'\\]', '', m.string[st[0]:m.start()]))
        st[0], st[1] = m.end(), (st[1] and len(parts) == 1) or bool(re.search(_sub(_RP_CMDS), parts[-1]))
        return m.group(0) if keep_rp and st[1] else m.group(1) + m.group(2) + '""'
    return re.sub(r'(?<=\s)(-[A-Za-z]*[mbt]|--message|--body|--title)(=|\s*)("(?:[^"\\]|\\.)*"|\'[^\']*\')',
                  val, cmd, flags=re.S)

def dl_writes_protected(t):
    """curl/wget の出力先 (-o/--output/-O/-P/--output-dir・-w %output{}。束ね/付着/=付きも) が .git/・.claude/ 配下か。
    t は引用符と \\ を除いたテキスト。cd 後の相対出力先や変数経由は見ない (既知の限界)。"""
    for seg in re.split(r'&&|\|\||[;|\n]', t):
        toks = seg.split()
        for i, tok in enumerate(toks):
            longs, shorts = _DL.get(re.sub(r'.*[^\w-]', '', tok), ((), ''))
            if not shorts:
                continue
            if any(_PROT_PATH.search(p) for p in re.findall(r'%output\{>*([^}]*)', seg)):
                return True
            args = toks[i + 1:] + ['']
            for j, a in enumerate(args):
                name, eq, v = a[2:].partition('=')
                m = re.match(rf'-[A-Za-z]*?[{shorts}](.*)', a)  # 束ねた短い旗: 最初に現れる出力旗の残りが値 (無ければ次の語)
                val = ''
                if a.startswith('--') and name and any(n.startswith(name) for n in longs):
                    val = v if eq else args[j + 1]
                elif m:
                    val = m.group(1) or args[j + 1]
                if _PROT_PATH.search(val):
                    return True
            break
    return False

def _is_read(seg):
    """git config の読取か。書込系フラグが無く、--get 系/--list/-l/--show-origin があるか、
    新構文 get/list か、値引数の無い `config <key>` (位置引数 1 個以下)。"""
    m = re.search(_sub('config') + r'(.*)', seg)
    if not m or re.search(r'--(?:unset|add|replace-all|remove-|rename-)', m.group(1)):
        return False
    if re.search(r'--get\b|--list\b|\s-l\b|--show-origin\b', m.group(1)):
        return True
    args = re.sub(r'(?<!\S)\d*[<>]+&?\s*[^\s"\']*', '', m.group(1))  # リダイレクトは値に数えない
    pos = [t for t in args.split() if not t.startswith('-')]
    return len(pos) <= 1 or pos[0] in ('get', 'list')

HOOKS = r'\.git/hooks(?![\w.-])|(?<![\w-])hooks/(?:pre-commit|pre-merge-commit|pre-push)(?![\w.-])'
MUTATE = (r'(?<![\w-])(?:rm|mv|cp|ln|chmod|install|tee|truncate|dd)(?=\s)|\s-delete\b'
          r'|(?<![\w-])(?:sed|perl)\b[^;&|\n]*\s-[A-Za-z]*i|>>?\s*\S*(?:' + HOOKS + ')')

def bypass_reason(cmd):
    """git hook を迂回する経路に当たれば理由 (str) を返す。無ければ None。"""
    s = strip_comments(cmd)  # コメントを先に除く (後だと `# <<'EOF'` で後続行が散文扱いになる)
    c = scrub_prose(s)
    rp = re.sub(r'["\'\\]', '', scrub_prose(s, keep_rp=True))  # 引用符・\ を除いた版 (--rec"eive-pack 対策。(h)(i) 用)
    cq = re.sub(r'["\'\\]', '', c)  # c から引用符・\ を除いた版 (--no-ver""ify 等の分割対策。--no-verify・--output・.git/hooks 用)
    if dl_writes_protected(rp):
        return '保護対象のファイルを curl/wget で上書きしようとしています (出力先が .git/・.claude/ 配下。hook や設定の差替えに使える)'
    if re.search(_CC + r'|\bunset\b[^;&|\n]*\bCLAUDECODE\b'
                 r'|\benv\b[^;&|\n]*(?:-u\s*|--unset[=\s])CLAUDECODE\b', c, re.I | re.M):
        return 'CLAUDECODE の改変 (git hook は CLAUDECODE=1 のときだけ作用します)'
    if 'git' not in c.lower():
        return None
    if any(re.search(r'(?i:--no-veri)', t) or re.search(_sub('commit') + r'[^;&|\n]*?\s-[A-Za-z]*n[A-Za-z]*(?=[\s;&|)"\']|$)', t)
           for t in (c, cq)):
        return '--no-verify / git commit -n (pre-commit・pre-push 等を飛ばす)'
    if re.search(r'(?<![$\w{])GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)\+?=', c) \
            or re.search(r'(?<![\w.])env\s+(?:-\S+\s+)*(?:-[A-Za-z]*i|--ignore-environment)\b', c):
        return 'GIT_CONFIG_* / env -i による git 設定・環境の改変'
    if re.search(_sub('send-pack'), c):
        return 'git send-pack (pre-push が走らない)'
    if re.search(_sub('update-ref') + r'[^;&|\n]*?(?i:(?:refs/)?heads/(?:' + '|'.join(PROTECTED) + r')(?![\w.-]))', c):
        return '保護ブランチの ref を直接動かす git update-ref'
    if any(re.search(_sub('(?:diff|log|show)') + r'[^;&|\n]*?(?<![\w-])--output(?![\w-])', t) for t in (c, cq)):
        return 'git diff/log/show の --output (任意のファイルへ書込める。.git/hooks の上書き等に使える)'
    if re.search(_sub(_RP_CMDS) + r'[^;&|\n]*?' + _RP_OPT, rp) \
            or re.search(_sub('clone') + r'[^;&|\n]*?\s-[A-Za-z]*u', rp) \
            or re.search(r'\bgit' + _OPTS + r'\s+--exec-path=', rp):
        return 'リモートヘルパーのプログラム実行オプション (--upload-pack / --receive-pack / --exec / clone -u / --exec-path=)'
    for seg in re.split(r'&&|\|\||[;|\n]', c):
        if re.search(_CFG, seg) and not _is_read(seg):
            if re.search(r'(?i:core\.hookspath|\binclude(?:if\.\S*)?\.path)', seg):
                return 'core.hooksPath / include.path の設定・上書き'
            if re.search(r'(?i:claudeguard)', seg):
                return 'claudeguard (リポジトリ単位の無効化キー) の書換'
        if re.search(HOOKS, seg) and re.search(MUTATE, seg):
            return '.git/hooks の変更'
    for seg in re.split(r'&&|\|\||[;|\n]', cq):  # 引用符・\ で分けた ".git/""hooks" 対策
        if re.search(HOOKS, seg) and re.search(MUTATE, seg):
            return '.git/hooks の変更'
    return None

try:
    data = json.load(sys.stdin)
    cmd = data.get('tool_input', {}).get('command', '')

    if not cmd:
        sys.exit(0)

    # git ネイティブ hook の迂回経路 (CLAUDECODE の改変は git を含まないコマンドでも対象)
    reason = bypass_reason(cmd)
    if reason:
        print(f'🔴 git hook を迂回する操作です: {reason}')
        print('保護ブランチへの commit/push 制限が無効になるため禁止です。必要なら本人が手動で実行してください。')
        sys.exit(2)

    if 'git' not in cmd:
        sys.exit(0)

    # git commit on protected branch
    if is_git_invocation(cmd, 'commit'):
        branch = current_branch(cmd)
        if branch in PROTECTED:
            print(f'🔴 保護されたブランチ "{branch}" 上でコミットしようとしました。')
            print('作業ブランチを作成してから作業してください。')
            print('  /create-branch を使用するか:')
            print('  git checkout -b <prefix>/<summary>_YYYYMMDD')
            sys.exit(2)

    # git push (non-force)
    if is_git_invocation(cmd, 'push') and not re.search(r'(?:-f\b|--force\b|--force-with-lease\b)', cmd):
        # ブランチ削除系 push（--delete / -d / コロン refspec ":branch"）は、削除先 ref が
        # 保護ブランチかどうかで判定する。本質は「現在ブランチ」ではなく「削除先」なので、
        # 現在ブランチが保護ブランチか否かに依存せず常に評価する（非保護の作業ブランチから
        # `git push origin --delete develop` が素通りしていた穴を塞ぐ）。
        is_delete = bool(re.search(r'--delete\b|(?:^|\s)-d\b|\s:\S', cmd))
        if is_delete:
            def _is_protected_ref(ref):
                # git の ref DWIM 解決に合わせ、先頭の refs/heads/ ・ heads/ を正規化する
                # (heads/develop も git は refs/heads/develop に解決するため保護対象)。
                ref = _strip_quotes(ref)
                ref = re.sub(r'^(?:refs/)?heads/', '', ref).strip('/')
                return any(ref == b or ref.startswith(b + '/') for b in PROTECTED)
            # 削除対象トークンを安全な ref 名文字種 [A-Za-z0-9._/-] に限定する。それ以外の文字
            # （コマンド置換 $()・変数 $VAR・バックティック・クォート・バックスラッシュ・glob 等の
            # 展開/難読化）を含むトークンは fail-safe でブロックする。
            SAFE_REF = re.compile(r'^[A-Za-z0-9._/-]+$')
            targets = []
            for tok in re.split(r'\s+', cmd):
                t = _strip_quotes(tok)
                if not t or t.startswith('-'):
                    continue
                if ':' in t:                 # :branch / src:dst の削除は dst を対象にする
                    t = t.split(':', 1)[1]
                    if not t:
                        continue
                if not SAFE_REF.match(t):
                    print('🔴 削除対象の ref 名を解決できません（展開・特殊文字を含む push --delete）。')
                    print('保護ブランチ削除の取りこぼしを防ぐため、手動で確認してから実行してください。')
                    sys.exit(2)
                targets.append(t)
            if any(_is_protected_ref(t) for t in targets):
                print('🔴 保護されたブランチを削除しようとしました。')
                print('保護ブランチ（main / master / develop 等）の削除は禁止です。')
                sys.exit(2)
            sys.exit(0)  # 非保護ブランチの削除は許可（現在ブランチに依存しない）
        # 非削除の push: 保護ブランチ上からの直接 push を禁止する
        branch = current_branch(cmd)
        if branch in PROTECTED:
            print(f'🔴 保護されたブランチ "{branch}" から直接 push しようとしました。')
            print('作業ブランチから PR を作成してください。')
            print('  /create-branch → 実装 → /create-pr の手順で進めてください。')
            sys.exit(2)

    # git push --force / --force-with-lease to protected branch
    push_force = re.search(r'(?:^|&&|\|\||;|\n)\s*(?:\S+\s+)*git\s+push\s+.*(?:-f\b|--force\b|--force-with-lease\b)', cmd, re.MULTILINE)
    if push_force:
        for b in PROTECTED:
            if re.search(rf'\b{b}\b', cmd):
                print(f'🔴 git push --force を {b} ブランチに対して実行しようとしました。')
                print('保護されたブランチへの force push は禁止です。')
                sys.exit(2)

    # git reset --hard with unpushed commits
    if re.search(r'\bgit\s+reset\s+.*--hard\b', cmd):
        try:
            r = subprocess.run(
                ['git', 'log', '@{u}..HEAD', '--oneline'],
                capture_output=True, text=True, timeout=5
            )
            if r.returncode == 0 and r.stdout.strip():
                count = len(r.stdout.strip().split('\n'))
                print(f'🔴 未プッシュのコミットが {count} 件あります。git reset --hard で失われます。')
                print(f'未プッシュコミット:\n{r.stdout}')
                sys.exit(2)
        except Exception:
            pass

    # git clean -fd / -df / etc
    if re.search(r'\bgit\s+clean\s+.*-[a-z]*f[a-z]*d|--force.*-d|-d.*--force', cmd):
        print('🔴 git clean -fd は未追跡ファイル・ディレクトリを完全削除します。')
        print('意図したものか確認してから手動で実行してください。')
        sys.exit(2)

    # git checkout . / git restore . (uncommitted changes wipe)
    if re.search(r'\bgit\s+(checkout|restore)\s+\.\s*$', cmd):
        print('🔴 git checkout . / git restore . は未コミットの変更をすべて破棄します。')
        print('意図したものか確認してから手動で実行してください。')
        sys.exit(2)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
