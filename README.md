# claude-engineering

エンジニアリング開発ワークフロー（要件→設計→実装→レビュー→PR→デプロイの自走フロー、TDD、git 運用規律）を1つの**プロジェクト**の `.claude/` に導入するための foundation リポジトリ。

> グローバルに常時ロードされる中立ルール（コーディングスタイルの基礎・協働スタイル・秘密衛生の基本など）は、別リポジトリの **core foundation**（`~/.claude/` にインストールされる）が正本。このリポジトリはそこに乗る「エンジニアリング領域」の実装層のみを持つ。

## このリポジトリが持つもの

| ディレクトリ/ファイル | 内容 |
|---|---|
| `rules/` | コーディングスタイル・コードレベルセキュリティ・git 運用・並列/worktree・テスト・エージェント運用・ループ安全の各ルール |
| `commands/` | 23個のスラッシュコマンド（`/requirements` `/design` `/plan` `/tdd` `/autorun` `/create-pr` `/deploy` `/review-loop` など） |
| `agents/` | 18体のカスタムエージェント（architect, planner, tdd-guide, reviewer, fixer, requirements-analyst, deploy-runner, executor, git-runner など） |
| `skills/` | `git-workflow`（コミット/ブランチ/PR規約の参照スキル）と `review-html`（確認画面。`/autorun` のゲートとチャットの相談で使う。ADR-032・ADR-033）。コードを書く/直す段は `/autorun` を唯一の入口とし、`agents/tdd-guide.md`・`agents/planner.md` が実行部品を担う（旧`loop-engineering`スキルは ADR-025 で廃止・再配分） |
| `hooks/` | 保護ブランチ編集ガード・git 破壊操作ブロック・PR base チェック・コミットメッセージ規約チェックと、それぞれのテスト |
| `workflows/` | `large-scope-execute.js`（大規模タスクの計画→赤確認→実装→検証を回す Workflow） |
| `templates/` | `init-autonomous/`（`/init-autonomous` コマンドが生成するプロジェクト側ファイルのテンプレート集）と `deploy/`（`deploy-runner` が使うデプロイ契約 `.claude/deploy.md` と Cloudflare Workers 用 `wrangler.jsonc` の雛形） |
| `docs/` | `autorun-flow.md`（自走フローの遷移定義。プロジェクトへは `.claude/docs/autorun-flow.md` としてインストールされる） |
| `installer.py` | インストールエンジン本体（core foundation と共有。差分検知・衝突保護・settings.json 構造マージなど） |
| `install.py` | 本リポジトリ用の薄い配線（`Pack` 定義のみ。ロジックは `installer.py`） |
| `settings-fragment.json` | 導入先の `.claude/settings.json` にマージされる hooks / permissions / enabledPlugins 断片 |

## 導入先は「1つのプロジェクト」だけ（`~/.claude` には絶対にインストールしない）

このパックは `kind="project"` で、**1プロジェクトの `.claude/` 配下**にのみインストールする。対象プロジェクトへ `cd` して実行すればそのディレクトリの `.claude/` が対象になり、`--project /abs/path` で明示指定もできる。どちらの場合も `~/.claude`（グローバル）をターゲットにすることはできない（core foundation とは別の配布経路）。

```bash
python3 install.py install --project /abs/path/to/your-project
```

### エイリアス設定（推奨）

毎回フルパスを打たずに済むよう、`~/.zshrc` に次の関数を追加して `source ~/.zshrc`（または新しいターミナル）で有効化する:

```bash
# 対象プロジェクトへ cd してから実行する
claude-eng()  { python3 "$HOME/dotfiles/claude-engineering/install.py" "$@"; }
```

以降は対象プロジェクトで動詞付きに実行するだけでよい:

```bash
cd /path/to/your-project
claude-eng install
```

- `--project`/`--target` を省略するとカレントディレクトリ（`./.claude`）が対象。foundation リポジトリ自身の中で実行した場合は拒否される（`cd` 先を間違えたときの保護）。
- action 動詞（`install`/`update`/`uninstall`/`verify`）は必須。動詞なしで実行すると usage を表示するだけでインストールしない。
- `--dry-run`・`--force`・`--project /abs/path` などのフラグ・オプションはそのまま透過する。

## コマンド一覧

エイリアス（`claude-eng`）を設定済みなら、対象プロジェクトで:

| 操作 | コマンド | 内容 |
|---|---|---|
| install | `claude-eng install` | 初回導入。既存の管理外ファイルと衝突する場合は中断する（`--force` で退避の上上書き） |
| dry-run | `claude-eng install --dry-run` | 何も書き込まず、NEW/UPDATE/REMOVE_STALE の計画だけを表示する |
| update | `claude-eng update` | 差分のみ更新。ローカルで手を入れたファイルがあれば中断する（`--force` で退避の上上書き） |
| verify | `claude-eng verify` | 何も書き込まず、導入済みファイルが改変されていないか照合する |
| uninstall | `claude-eng uninstall` | 本パックが導入したファイルのみを削除する（ユーザーの他ファイルやローカル改変ファイルは残す。`--force` で改変ファイルも削除） |

エイリアス未設定なら、同じ動詞を `python3 /path/to/claude-engineering/install.py <動詞>` に渡す。`--target /abs/path` で `.claude` そのものではない任意のディレクトリを直接指定することもできる（主にテスト用）。

## クロスドメイン拒否

導入先プロジェクトの `.claude/` に、他ドメインの foundation（例: `claude-work-agent`）が既に導入済みであることを示すマニフェスト（`.claude-work-agent.manifest.json`）が存在する場合、本パックのインストールは**拒否**される。逆に、本パック導入済みのプロジェクトへ他ドメインの foundation を導入しようとした場合も同様に拒否される（1プロジェクト=1ドメインの原則）。

## 含まれないもの

- **認証情報・トークンの類は一切含まない。** 秘密の取り扱い（ハードコード禁止・env 管理・add 時ブロック）は core foundation 側の責務。
- **MCP サーバーの自動有効化は行わない。** `settings-fragment.json` は hooks・permissions・`enabledPlugins`（GitHub/コミット/レビュー/セキュリティ/フロントエンドデザインの公式プラグイン）のみを持ち、MCP サーバー定義（`mcp.json` 相当）は含まない。

## 権限 (`permissions.allow`) の方針

- **目的**: 自走フローで毎回確認が出ないよう、パックが実際に使う git / gh の操作と、deploy-runner の公開後検証に要る読み取り専用の `curl` 2形だけを許可します。それ以外は確認（auto モードでは分類器）を通ります。広い `Bash(git *)` などは付けません。
- **許可するもの**:
  - git: `status` / `diff` / `log` / `show` / `branch` / `rev-parse` / `ls-files` / `add` / `commit` / `checkout` / `switch` / `restore` / `worktree`。`fetch` / `pull` / `push` は無引数か `origin` 宛のみです。
  - gh: `pr create` / `view` / `checks` / `list` / `diff`、`issue view` / `list`、`run watch` / `view` / `list`。
  - curl: deploy-runner の公開後検証の2形だけです（下の「curl の許可と拒否」を参照）。書込系のフラグは `permissions.deny` で拒否します。
- **許可しないものと理由**:
  - `git config` / `git -c` / `git -C`: 設定経由で任意のコマンドを実行できます。`-C` は `*` と組むと `-c` を通す穴になります。
  - `git remote` / `reset` / `clean` / `rm` / `rebase`: 破壊的な操作か、宛先を変える操作です。サブコマンドとして許可しないだけで、許可したサブコマンドの破壊的なオプションまでは防げません（下の「許可はサブコマンド単位」を参照）。
  - `gh api`: 任意の GitHub API の書込・削除ができます。
  - `gh pr merge` / `gh workflow run` / `issue`・`pr` への書込: 外向きで取り消せない操作は人が確認します。
  - `gh alias` / `gh extension`: 任意のコードを実行できます。
  - `claude *`: 許可に含めません（以前の許可は削除しました）。パックのエージェント・コマンドが実行する箇所がありません（`/init-autonomous` が人に向けて表示する `claude mcp add ...` の案内文だけです）。
- **curl の許可と拒否**: 許可するのは deploy-runner の公開後検証が使う次の2形だけです。広い `Bash(curl *)` は付けません。
  - ページ（GET）: `Bash(curl -sS --max-time * -o /tmp/* -w *)`（`curl -sS --max-time N -o /tmp/<body file> -w '%{http_code}' <url>`）。本文の保存先は `/tmp/` 配下に固定しています。一意な名前が要るときは、`mktemp /tmp/smoke-body.XXXXXX` を別のコマンドとして先に実行し、表示されたパスを curl の行へそのまま書きます（`$(...)` は使えません）。
  - アセット（HEAD）: `Bash(curl -sS --head --max-time * -o /dev/null -w *)`（`curl -sS --head --max-time N -o /dev/null -w '%{http_code} %{content_type}' <url>`）。HEAD の形は `-o /dev/null` に固定しています。
  - データ送信・アップロード・メソッド変更・設定ファイル読込のフラグ（`-d` / `--data*` / `--json` / `-F` / `--form` / `-T` / `--upload-file` / `-X` / `--request` / `-K` / `--config`）は、`permissions.deny` の `Bash(curl * <フラグ>*)` で拒否します。deny は allow より優先されます。
  - ローカルファイルの中身を送る形（`-H @<ファイル>` / `--url-query @<ファイル>` / `--variable x@<ファイル>` / `$(cat <ファイル>)`）と、`/tmp/` から出る `..` は、`@` / `$(` / バッククォート / `..` を含む curl を `permissions.deny` の `Bash(curl *<文字列>*)` で拒否します。URL に `@`（ユーザー情報）や `..` を含む検証は通りません。
  - 残るリスク:
    - 引数のパターンは壊れやすく、セキュリティ境界ではありません。
    - ページの形は `--max-time *` の `*` が任意の文字に一致するため、`--max-time 10 -o ~/.zshrc -o /tmp/x` のように先に別の `-o` を置く形までは `permissions.allow` の文字列では防げません。`.git/`・`.claude/` への書込だけは `hooks/git-destructive-blocker.py` が止めます。
    - クォートやオプションの連結（例 `-sd`）で deny を避けられる可能性があります。URL やヘッダーに値を載せる送信も止められません。
    - プロジェクトの設定にすでに広い `Bash(curl *)` があれば、実効の許可は広いままです（deny は残りますが、上の理由で完全ではありません）。
- **許可はサブコマンド単位で、フラグまでは絞れません**: 許可は前方一致のため、許可した git サブコマンドの破壊的なオプション形も、確認なしで自動で通ります。
  - 例: `git branch -D` / `-f` / `-M`、`git checkout -B` / `-f`、`git switch -C` / `--discard-changes`、`git restore -- .`、`git worktree remove --force`、`git diff` / `log` / `show` の `--output=<ファイル>`（ファイルを書き込む）、`git push origin --mirror` / `--prune`。
  - これらを止めるのは、Claude 側の hook `hooks/git-destructive-blocker.py`（ベストエフォートの文字列判定。例: `reset --hard`（未プッシュのコミットがあるとき）・`clean -fd`・`checkout .`）か、git ネイティブの hook が捕まえた場合だけです。
  - 保護ブランチへの push / commit は、導入したリポジトリでは git ネイティブの hook が止めます（「Git フック」を参照）。
- **限界**: 許可はコマンド文字列の前方一致で、許可したサブコマンドのオプション（例 `git fetch origin --upload-pack=...`）までは制限できません（`--upload-pack` / `--receive-pack` / `--exec` だけは、Claude 側の hook `hooks/git-destructive-blocker.py` がベストエフォートで止めます）。PR の base は `pr-base-checker.py` が文字列で確認します。いずれも [ADR-028](https://github.com/ShigetomoYamamoto/claude-core/blob/main/docs/adr/028-command-string-guard-limits.md) のとおり「コマンド文字列を判定する層は不完全」を前提とした多層防御であり、境界ではありません。
- **例外が要るとき**: プロジェクト側の `.claude/settings.local.json` に追加します。パック管理外なので `update` で消えません。
- **導入済みプロジェクトでの注意**: `install.py update` は `permissions.allow` / `permissions.deny` を和集合でマージし、古いエントリを消しません。すでに導入済みのプロジェクトは `update` したあと、そのプロジェクトの `.claude/settings.json` から旧4行（`Bash(git *)` `Bash(gh *)` `Bash(claude *)` `Bash(curl *)`）を手で削除する必要があります。`update` はそのリポジトリへ git フックも導入します（「Git フック (リポジトリごと)」を参照。飛ばすには `--no-git-hooks`）。またユーザー設定 `~/.claude/settings.json` など他スコープに同じ広い許可があると、`permissions.allow` はスコープ間で結合されるため、このパックで絞っても実効の許可は狭まりません。

## Git フック (リポジトリごと)

- `hooks/` の Claude Code 側のフックは、コマンド文字列を判定するベストエフォートの層です。不完全であることは [ADR-028](https://github.com/ShigetomoYamamoto/claude-core/blob/main/docs/adr/028-command-string-guard-limits.md) のとおりです。
- 実質的な止め役は、git ネイティブのフック（`git-hooks/guard.sh`）です。詳細は [`git-hooks/README.md`](./git-hooks/README.md) を参照してください。
- このフックは `CLAUDECODE=1` のときだけ作用します。
- `install.py install` / `update` が、導入先リポジトリの git フック用ディレクトリに `guard.sh` を `pre-commit` / `pre-merge-commit` / `pre-push` としてコピーします。
- 既存のフックは上書きしません。`core.hooksPath` が設定されている場合（husky など）や、他のフックがすでにある場合は、この手順を警告つきで飛ばし、終了コードは 0 以外になります。
- この手順だけを飛ばすには `--no-git-hooks` を付けます。
- 設定はすべてリポジトリごとで、マシン全体には何も入れません。

## 詳細

各層の役割は [`docs/engineering-architecture.md`](./docs/engineering-architecture.md) を参照。
