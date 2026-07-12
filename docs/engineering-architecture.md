# engineering-architecture

`claude-engineering` foundation が持つ層と、それぞれの役割の概要。

## 層構成

| 層 | ディレクトリ | 役割 |
|---|---|---|
| ルール | `rules/` | 常時参照される規律（コーディングスタイル・コードレベルセキュリティ・git 運用・並列/worktree・テスト・エージェント運用・ループ安全）。プロジェクトの `.claude/rules/` に配置され、セッション開始時に読み込まれる想定 |
| コマンド | `commands/` | `/requirements` `/design` `/plan` `/tdd` `/autorun` `/create-pr` `/deploy` `/review-loop` などのスラッシュコマンド定義 |
| エージェント | `agents/` | architect・planner・tdd-guide・reviewer・fixer・requirements-analyst・deploy-runner・executor・git-runner など、役割ごとに分離したサブエージェント定義 |
| スキル | `skills/` | `git-workflow`（コミット/ブランチ/PR 規約の参照スキル）・`loop-engineering`（1タスクを VISION→テスト→レッド/グリーン→レビュー→完了判定で完成させるミクロ実装スキル。`reference/` に補助資料） |
| フック | `hooks/` | 保護ブランチ編集ガード（`protected-branch-edit-guard.py`）・git 破壊操作ブロック（`git-destructive-blocker.py`）・PR base チェック（`pr-base-checker.py`）・コミットメッセージ規約チェック（`commit-msg-convention.py`）。各テストを同梱 |
| ワークフロー | `workflows/` | `loop-engineering-large-A.js`（大規模タスク向けの計画→赤確認→実装→検証を回す Workflow テンプレート） |
| テンプレート | `templates/` | `init-autonomous/`（`/init-autonomous` コマンドが生成するプロジェクト側 CLAUDE.md・rules・commands・agents・docs 等のテンプレート） |
| ドキュメント | `docs/` | `autorun-flow.md`（自走フローの遷移定義。導入先では `.claude/docs/autorun-flow.md` として配置される） |

## 自走フロー（Loop Engineering）とこのリポジトリの関係

- **ミクロ実装層**: `skills/loop-engineering/` と `commands/review-loop.md`（+ `agents/reviewer.md` / `agents/fixer.md`）が、1タスクを VISION→テスト→レッド/グリーン→レビュー往復→完了判定で完成させる。
- **マクロ自走層**: `docs/autorun-flow.md`（遷移定義）と `commands/autorun.md`（解釈・実行）が、要件→設計→実装→PR/デプロイを、関門4点（要件・設計・PR・デプロイ）以外は自動連結する。
- **安全層（横串）**: `rules/loop-safety.md` が前提条件・ハードストップ・ゴールドリフト・不可逆操作確認の正本。
- **並列層（横串）**: `rules/parallel-worktree.md` が並列エージェントの worktree 分離規律。

## core foundation との境界

- **常時ロードされるグローバル中立ルール**（コーディングスタイルの基礎・協働スタイル・秘密衛生の基本など）はこのリポジトリではなく、別リポジトリの **core foundation** が持ち、`~/.claude/` にインストールされる。
- 本リポジトリはその上に乗る**エンジニアリング領域固有の実装**（開発ワークフロー・自走・TDD・git 運用）のみを持ち、単一の明示されたプロジェクトの `.claude/` にインストールされる（`install.py` 参照）。
- 秘密衛生の基本衛生は `rules/coding-security.md` の冒頭注記が示す通り core foundation の `rules/secret-hygiene.md` が正本であり、このリポジトリの `rules/coding-security.md` はコードレベルのセキュリティ観点（入力検証・SQLi・XSS・CSRF・認可・レート制限・エラー漏洩）のみを扱う。
