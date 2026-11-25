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

- **目的**: 自走フローで毎回確認が出ないよう、パックが実際に使う git / gh の操作だけを許可します。curl は許可も拒否もしません。それ以外は確認（auto モードでは分類器）を通ります。広い `Bash(git *)` などは付けません。
- **許可するもの**:
  - git: `status` / `diff` / `log` / `show` / `branch` / `rev-parse` / `ls-files` / `add` / `commit` / `checkout` / `switch` / `restore` / `worktree`。`fetch` / `pull` / `push` は無引数か `origin` 宛のみです。
  - gh: `pr create` / `view` / `checks` / `list` / `diff`、`issue view` / `list`、`run watch` / `view` / `list`。
  - curl: 許可しません（下の「curl の扱い」を参照）。
- **許可しないものと理由**:
  - `git config` / `git -c` / `git -C`: 設定経由で任意のコマンドを実行できます。`-C` は `*` と組むと `-c` を通す穴になります。
  - `git remote` / `reset` / `clean` / `rm` / `rebase`: 破壊的な操作か、宛先を変える操作です。サブコマンドとして許可しないだけで、許可したサブコマンドの破壊的なオプションまでは防げません（下の「許可はサブコマンド単位」を参照）。
  - `gh api`: 任意の GitHub API の書込・削除ができます。
  - `gh pr merge` / `gh workflow run` / `issue`・`pr` への書込: 外向きで取り消せない操作は人が確認します。
  - `gh alias` / `gh extension`: 任意のコードを実行できます。
  - `claude *`: 許可に含めません（以前の許可は削除しました）。パックのエージェント・コマンドが実行する箇所がありません（`/init-autonomous` が人に向けて表示する `claude mcp add ...` の案内文だけです）。
- **curl の扱い**: curl の許可も拒否も付けません。deploy-runner の公開後検証の curl も、通常の確認（auto モードでは分類器）を通ります。
  - 許可しない理由: ワイルドカード付きの curl の許可は、後ろに足したフラグで広げられます（2つ目の `-o ~/.zshrc`、`-D`、`--trace`、`--output-dir` など）。URL に `$SECRET` のようなシェル展開を載せて、環境変数の値を外へ送ることもできます。以前出していた2形（`Bash(curl -sS --max-time * -o * -w *)` と `Bash(curl -sS --head --max-time * -o /dev/null -w *)`）は削除しました。
  - 拒否しない理由: 以前は、書込系のフラグ（`-d` / `--data*` / `--json` / `-F` / `--form` / `-T` / `--upload-file` / `-X` / `--request` / `-K` / `--config`）と、`@`・`$(`・バッククォート・`..` を含む curl を `permissions.deny` で拒否していました（15行）。これは curl の許可を絞るための補助でした。その許可を削除したあとは、どの権限モード（bypass を含む）でも curl を一律に止めるだけになり、`curl -X POST` や `-H "Authorization: Bearer $(gh auth token)"` のような正当な使い方まで塞ぎます。他のツールで同じことができるため防御の効果は小さく、「ブランチの保護は git 自身のフックが行い、Claude 側の hook はフックを無効にする操作だけを止める」という本パックの方針の外でもあるため、撤去しました。
  - 導入済みプロジェクト: `install.py update` は、撤去した2つの許可と15行の拒否（過去に配布した不均衡な綴り `Bash(curl *$(*)` を含む）に一致する行だけを、導入先の `permissions.allow` / `permissions.deny` から取り除きます。利用者が足した curl の許可・拒否（例 `Bash(rm -rf /*)`）には触れません。
  - 残るリスク:
    - 出力先が `.git/`・`.claude/` 配下の curl / wget だけは、`hooks/git-destructive-blocker.py` が止めます。
    - 許可がないので curl は通常の確認（auto モードでは分類器）を通りますが、bypass モードでは確認なしで実行されます。
    - プロジェクトやユーザー設定にすでに広い `Bash(curl *)` があれば、その許可は残ります。
- **許可はサブコマンド単位で、フラグまでは絞れません**: 許可は前方一致のため、許可した git サブコマンドの破壊的なオプション形も、確認なしで自動で通ります。
  - 例: `git branch -D` / `-f` / `-M`、`git checkout -B` / `-f`、`git switch -C` / `--discard-changes`、`git restore -- .`、`git worktree remove --force`、`git diff` / `log` / `show` の `--output=<ファイル>`（ファイルを書き込む）、`git push origin --mirror` / `--prune`。
  - これらを止めるのは、Claude 側の hook `hooks/git-destructive-blocker.py`（ベストエフォートの文字列判定。例: `reset --hard`（未プッシュのコミットがあるとき）・`clean -fd`・`checkout .`）か、git ネイティブの hook が捕まえた場合だけです。
  - 保護ブランチへの push / commit は、導入したリポジトリでは git ネイティブの hook が止めます（「Git フック」を参照）。
- **限界**: 許可はコマンド文字列の前方一致で、許可したサブコマンドのオプション（例 `git fetch origin --upload-pack=...`）までは制限できません（`--upload-pack` / `--receive-pack` / `--exec` だけは、Claude 側の hook `hooks/git-destructive-blocker.py` がベストエフォートで止めます）。PR の base は `pr-base-checker.py` が文字列で確認します。いずれも [ADR-028](https://github.com/ShigetomoYamamoto/claude-core/blob/main/docs/adr/028-command-string-guard-limits.md) のとおり「コマンド文字列を判定する層は不完全」を前提とした多層防御であり、境界ではありません。
- **例外が要るとき**: プロジェクト側の `.claude/settings.local.json` に追加します。パック管理外なので `update` で消えません。
- **導入済みプロジェクトでの注意**: `install.py update` は `permissions.allow` / `permissions.deny` を和集合でマージし、古いエントリを消しません（例外: このパックが取り下げた curl の許可2行と拒否15行は、上の「curl の扱い」のとおり `update` が取り除きます）。すでに導入済みのプロジェクトは `update` したあと、そのプロジェクトの `.claude/settings.json` から旧4行（`Bash(git *)` `Bash(gh *)` `Bash(claude *)` `Bash(curl *)`）を手で削除する必要があります。`update` はそのリポジトリへ git フックも導入します（「Git フック (リポジトリごと)」を参照。飛ばすには `--no-git-hooks`）。またユーザー設定 `~/.claude/settings.json` など他スコープに同じ広い許可があると、`permissions.allow` はスコープ間で結合されるため、このパックで絞っても実効の許可は狭まりません。

## PR の宛先 (base) をプロジェクトごとに追加で許可する

- 既定では、`hooks/pr-base-checker.py` は `gh pr create` の `--base` が `develop` 以外だとブロックします。
- `main` しか無いリポジトリなど、特定のプロジェクトだけ別の宛先を許したいときは、利用者（人間）が決めて、そのプロジェクトの `.claude/pr-bases.json` に書きます。ブロックされた Claude が自分で書いて通すためのものではありません（ブロック表示も、本人に確認するよう促すだけで、書き方は案内しません）。
  - 例: `{"allow": ["main"]}`（`develop` は常に許可なので書かなくてよい）。
  - 場所は hook 自身の位置（`.claude/hooks/` の 1 つ上）から決めます。作業ディレクトリでは決めません。
  - プロジェクトが所有するファイルです。インストーラは作らず、`update` / `uninstall` でも触りません。
  - ファイルが無い・JSON として壊れている・形が違う（`allow` が配列でない）・branch 名として不正な値（英数字と `. _ / -` 以外）は無視し、`develop` のみに倒れます。許可が広がる方向には失敗しません。
- トレードオフ: 技術的には Claude 自身もこのファイルを作れてしまいます（git config と違い、ユーザーの手を借りずに済みます）。そのため、これは利用者の判断で置く設定として扱い、Claude が許可のために自分で書き足したものは認めません。追加や変更は必ず PR の差分に出るので、レビューで確認してください。
- この hook はコマンド文字列を見るだけのベストエフォートです。保護ブランチ自体への push / commit は、これまでどおり git ネイティブのフック（「Git フック」を参照）が止めます。

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
