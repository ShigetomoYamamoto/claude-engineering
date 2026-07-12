---
description: |
  現在のブランチと develop の差分を分析し、
  テンプレートに沿った Pull Request を gh コマンドで作成します。
argument-hint: [タイトルヒント]
---

# PR作成手順

> 引数「タイトルヒント」（任意）: PRタイトルのヒント。省略時はコミット履歴から自動生成する。

## ステップ 1: 現状確認

以下を並行して実行する：

- `git status` — 未コミットの変更がないか確認
- `git log develop...HEAD --oneline` — このブランチのコミット一覧
- `git diff develop...HEAD --stat` — 変更ファイルの統計

⚠️ **未コミットの変更がある場合は警告して停止する。** コミットを先に完了させること。

## ステップ 2: 差分の詳細分析

```bash
git diff develop...HEAD
```

全差分を読み込み、以下を把握する：

- 変更の目的（バグ修正 / 機能追加 / リファクタリング など）
- 影響範囲（どのシステム・機能に関わるか）
- 注目すべき実装の変更点

## ステップ 3: コードレビュー

**code-reviewer エージェント**を起動して `git diff develop...HEAD` の全差分をレビューする。

- CRITICAL / HIGH の指摘があれば **PR作成を中断し、先に修正してコミットする**
- MEDIUM 以下の指摘はユーザーに提示した上で続行してよい

差分に以下のいずれかが含まれる場合は **security-reviewer エージェント**も追加で起動する：
- 認証・セッション・トークン処理
- ユーザー入力のバリデーション・サニタイズ
- API エンドポイントの追加・変更
- シークレット・環境変数の参照
- 決済・課金・個人情報の処理

## ステップ 4: PRタイトルとDescription の生成

Description テンプレート・Summary/Test plan の書き方は `~/.claude/skills/git-workflow/SKILL.md` を参照すること。

### タイトルのルール

- 70文字以内
- `type: 内容` 形式（Conventional Commits に準拠）
- 日本語で記述

## ステップ 5: PR作成前の確認

生成したタイトルと Description をユーザーに提示して承認を得る。

## ステップ 6: リモートへのプッシュ（未プッシュの場合）

**ステップ5の承認を得てから push する**（外向き操作を承認前に行わない）。
現在のブランチがリモートに存在しない、または未プッシュのコミットがある場合：

```bash
git push -u origin <current-branch>
```

## ステップ 7: PR作成実行

```bash
gh pr create \
  --base develop \
  --title "<生成したタイトル>" \
  --body "$(cat <<'EOF'
<生成した Description>
EOF
)"
```

### vibing 例外（`/autorun --vibing` 実行時のみ・ADR-015）

vibing モードで pr フェーズを実行する場合に限り、base を `main` にし、コマンドの**末尾**に
vibing マーカーのシェルコメントを付けて `pr-base-checker.py` の例外を通す（無印・通常運用では
このステップは使わず常に develop ベース）。マーカーは末尾コメント位置（`#\s*__VIBING_AUTORUN_PR__\s*$`）
でのみ有効で、`--title`/`--body` に書いても通らない:

```bash
gh pr create \
  --base main \
  --title "<生成したタイトル>" \
  --body "$(cat <<'EOF'
<生成した Description>
EOF
)"  # __VIBING_AUTORUN_PR__
```

## ステップ 8: 完了報告

PR作成後、以下を表示する：

- PR の URL
- タイトル
- base ブランチ → head ブランチ

## 注意事項

⚠️ **push はステップ5（タイトル・Description の承認）後に実行する。承認前にブランチを push しない。**

⚠️ **PRを作成する前に必ずタイトルと Description をユーザーに確認すること。**

⚠️ **base ブランチは常に `develop` とする。**（main / master へのダイレクトPRは行わない）
唯一の例外は `/autorun --vibing` 実行時のステップ7 vibing 分岐（末尾マーカー付き `--base main`・ADR-015）。

⚠️ **未コミットの変更がある場合は `/commit-commands:commit` を先に実行するよう案内すること。**
