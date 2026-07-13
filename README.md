# claude-engineering

エンジニアリング開発ワークフロー（要件→設計→実装→レビュー→PR→デプロイの自走フロー、TDD、git 運用規律）を1つの**プロジェクト**の `.claude/` に導入するための foundation リポジトリ。

> グローバルに常時ロードされる中立ルール（コーディングスタイルの基礎・協働スタイル・秘密衛生の基本など）は、別リポジトリの **core foundation**（`~/.claude/` にインストールされる）が正本。このリポジトリはそこに乗る「エンジニアリング領域」の実装層のみを持つ。

## このリポジトリが持つもの

| ディレクトリ/ファイル | 内容 |
|---|---|
| `rules/` | コーディングスタイル・コードレベルセキュリティ・git 運用・並列/worktree・テスト・エージェント運用・ループ安全の各ルール |
| `commands/` | 23個のスラッシュコマンド（`/requirements` `/design` `/plan` `/tdd` `/autorun` `/create-pr` `/deploy` `/review-loop` など） |
| `agents/` | 18体のカスタムエージェント（architect, planner, tdd-guide, reviewer, fixer, requirements-analyst, deploy-runner, executor, git-runner など） |
| `skills/` | `git-workflow`（コミット/ブランチ/PR規約の参照スキル）・`loop-engineering`（ミクロ層の自走実装スキル、`reference/` 同梱） |
| `hooks/` | 保護ブランチ編集ガード・git 破壊操作ブロック・PR base チェック・コミットメッセージ規約チェックと、それぞれのテスト |
| `workflows/` | `loop-engineering-large-A.js`（大規模タスクの計画→赤確認→実装→検証を回す Workflow） |
| `templates/` | `init-autonomous/`（`/init-autonomous` コマンドが生成するプロジェクト側ファイルのテンプレート集） |
| `docs/` | `autorun-flow.md`（自走フローの遷移定義。プロジェクトへは `.claude/docs/autorun-flow.md` としてインストールされる） |
| `installer.py` | インストールエンジン本体（core foundation と共有。差分検知・衝突保護・settings.json 構造マージなど） |
| `install.py` | 本リポジトリ用の薄い配線（`Pack` 定義のみ。ロジックは `installer.py`） |
| `settings-fragment.json` | 導入先の `.claude/settings.json` にマージされる hooks / permissions / enabledPlugins 断片 |

## 導入先は「1つのプロジェクト」だけ（`~/.claude` には絶対にインストールしない）

このパックは `kind="project"` で、**明示的に指定した1プロジェクトの `.claude/` 配下**にのみインストールする。`--project /abs/path` の指定が必須で、`~/.claude` をターゲットにすることはできない（core foundation とは別の配布経路）。

```bash
python3 install.py install --project /abs/path/to/your-project
```

> **省略形:** 対象プロジェクトへ `cd` してから `--project` なしで実行すると、カレントディレクトリ（`./.claude`）を対象にインストールする。foundation リポジトリ自身の中で実行した場合は拒否される。`~/.zshrc` の `claude-eng` 関数（`cd 対象プロジェクト && claude-eng`）を使うのが推奨形で、`claude-eng install` / `claude-eng install --dry-run` / `claude-eng update` のようにサブコマンド・フラグはそのまま転送される。明示的な `--project /abs/path` 指定も従来どおり有効。action 動詞（`install`/`update`/`uninstall`/`verify`）は必須で、`claude-eng` を動詞なしで実行すると usage を表示して終了するだけで、インストールは行われない。

## コマンド

| 操作 | コマンド | 内容 |
|---|---|---|
| dry-run | `python3 install.py install --project /abs/path --dry-run` | 何も書き込まず、NEW/UPDATE/REMOVE_STALE の計画だけを表示する |
| install | `python3 install.py install --project /abs/path` | 初回導入。既存の管理外ファイルと衝突する場合は中断する（`--force` で退避の上上書き） |
| update | `python3 install.py update --project /abs/path` | 差分のみ更新。ローカルで手を入れたファイルがあれば中断する（`--force` で退避の上上書き） |
| verify | `python3 install.py verify --project /abs/path` | 何も書き込まず、導入済みファイルが改変されていないか照合する |
| uninstall | `python3 install.py uninstall --project /abs/path` | 本パックが導入したファイルのみを削除する（ユーザーの他ファイルやローカル改変ファイルは残す。`--force` で改変ファイルも削除） |

`--target /abs/path` で `.claude` そのものではない任意のディレクトリを直接指定することもできる（主にテスト用）。

## クロスドメイン拒否

導入先プロジェクトの `.claude/` に、他ドメインの foundation（例: `claude-work-agent`）が既に導入済みであることを示すマニフェスト（`.claude-work-agent.manifest.json`）が存在する場合、本パックのインストールは**拒否**される。逆に、本パック導入済みのプロジェクトへ他ドメインの foundation を導入しようとした場合も同様に拒否される（1プロジェクト=1ドメインの原則）。

## 含まれないもの

- **認証情報・トークンの類は一切含まない。** 秘密の取り扱い（ハードコード禁止・env 管理・add 時ブロック）は core foundation 側の責務。
- **MCP サーバーの自動有効化は行わない。** `settings-fragment.json` は hooks・permissions・`enabledPlugins`（GitHub/コミット/レビュー/セキュリティ/フロントエンドデザインの公式プラグイン）のみを持ち、MCP サーバー定義（`mcp.json` 相当）は含まない。

## 詳細

各層の役割は [`docs/engineering-architecture.md`](./docs/engineering-architecture.md) を参照。
