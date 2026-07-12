# init-autonomous テンプレート: .claude/commands/*（プロジェクト固有コマンド）

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-3. `.claude/commands/`

#### `.claude/commands/implement-feature.md`

```markdown
---
name: フィーチャー実装（TDD一気通貫）
description: 仕様確認 → TDD → 実装 → コードレビュー → コミットを一気通貫で実行します
---

# /implement-feature

引数として実装する機能名または Issue 番号を受け取る。

## 手順

### 1. 仕様確認

`docs/01_product-specifications.md` と `docs/02_detailed-design.md` を読む。
実装対象の機能に関するセクションを特定し、以下を整理する:
- 機能の目的と期待する動作
- 入力値・バリデーションルール
- 権限（どのロールが実行できるか）
- 境界条件・エラーケース

仕様が不明確な箇所があれば実装前にユーザーに確認する。

### 2. テストを先に書く（RED）

`{{ TEST_FRAMEWORK }}` でテストファイルを作成する。
以下のケースを網羅する:
- 正常系（ハッピーパス）
- バリデーションエラー
- 権限エラー
- 境界値

テストを実行して **FAIL することを確認する**。

### 3. 実装（GREEN）

テストがパスする最小限の実装を書く。
`.claude/rules/architecture.md` の責務分離ルールに従う。

テストを実行して **全件 PASS することを確認する**。

### 4. リファクタリング（REFACTOR）

コードの重複・命名・責務の分散を確認して改善する。
テストが引き続き PASS することを確認する。

### 5. コードレビュー

**code-reviewer** エージェント（公式 `pr-review-toolkit`）を起動してレビューを受ける。
CRITICAL・HIGH の指摘は修正してから次へ進む。

### 6. コミット

`/precommit-check` を実行してすべてパスすることを確認する。
Conventional Commits 形式でコミットする。
```

#### `.claude/commands/issue-to-pr.md`

```markdown
---
name: Issue → PR 全自動
description: GitHub Issue を読み込み、実装して PR を作成します
---

# /issue-to-pr

引数として Issue 番号を受け取る（例: `/issue-to-pr 42`）。

## 手順

### 1. Issue を読み込む

`gh issue view {{ Issue番号 }}` で Issue の内容を取得する。
以下を確認する:
- タイトルと説明
- 受け入れ条件（Acceptance Criteria）
- ラベル（`bug` / `feature` / `refactor` 等）

### 2. 仕様を確認する

`docs/01_product-specifications.md` と `docs/02_detailed-design.md` を読み、
Issue に関連するセクションを特定する。

### 3. ブランチを作成する

\`\`\`bash
git checkout develop
git pull origin develop
git checkout -b feature/issue-{{ Issue番号 }}_YYYYMMDD
\`\`\`

### 4. 実装する

`/implement-feature` の手順（TDD一気通貫）に従って実装する。

### 5. PR を作成する

`/create-pr` を実行して PR を作成する。
PR の説明に `Closes #{{ Issue番号 }}` を含める。
```

#### `.claude/commands/spec.md`

```markdown
---
name: 仕様確認
description: 実装前に仕様書の該当箇所を読んで整理します
---

# /spec

引数として機能名・エンドポイント・画面名等を受け取る。

## 手順

### 1. 仕様書を読む

以下を順に読んで対象機能の仕様を収集する:
1. `docs/01_product-specifications.md` — 対象機能の概要・画面・遷移
2. `docs/02_detailed-design.md` — バリデーション・権限・保存ロジック

### 2. 整理して出力する

以下の形式で整理して出力する:

\`\`\`
## {{ 機能名 }} の仕様

**目的:** ...
**対象ロール:** ...
**入力項目:**
- フィールド名: バリデーションルール
**出力/結果:** ...
**エラーケース:**
- ケース: 期待する動作
**不明点:** （ある場合のみ）
\`\`\`
```

#### `.claude/commands/precommit-check.md`

```markdown
---
name: プリコミットチェック
description: フォーマット・テスト・型チェック・静的解析を順番に実行します
---

# /precommit-check

## 手順

以下を順番に実行する。いずれかが失敗したら **その場で停止して修正する**。次のステップには進まない。

### 1. フォーマット

スタックに応じて実行する:
- Laravel: `./vendor/bin/pint`
- Node.js: `npm run format` または `npx prettier --write .`
- Python: `ruff format .`

### 2. Lint

スタックに応じて実行する:
- Laravel: `./vendor/bin/pint --test`
- Node.js: `npm run lint`
- Python: `ruff check .`

### 3. 型チェック（TypeScript 使用時）

\`\`\`bash
npx tsc --noEmit
\`\`\`

### 4. テスト（カバレッジ付き）

スタックに応じて実行する:
- Laravel: `./vendor/bin/pest --coverage --min=80`
- Node.js (Vitest): `npx vitest run --coverage`
- Node.js (Jest): `npx jest --coverage`
- Python: `pytest --cov --cov-fail-under=80`

カバレッジが 80% を下回る場合は追加テストを書いてから進む。

### 5. カスタム静的解析

\`\`\`bash
bash .github/scripts/audit-custom.sh
\`\`\`

### 6. 完了報告

全ステップが PASS したら「プリコミットチェック: 全 PASS ✅」と報告する。
```

#### `.claude/commands/create-pr.md`

```markdown
---
name: PR作成
description: コミット履歴を分析してPRテンプレを埋めて作成します
---

# /create-pr

## 手順

### 1. 変更内容を収集する

\`\`\`bash
git log develop..HEAD --oneline
git diff develop...HEAD --stat
\`\`\`

全コミット（最新だけでなく全件）を分析して変更の全容を把握する。

### 2. PR の情報を整理する

- タイトル: 70文字以内、`feat:` / `fix:` / `refactor:` プレフィックスを付ける
- 変更種別: 機能追加 / バグ修正 / リファクタリング / ドキュメント / CI
- 関連 Issue: `Closes #番号` があれば記載

### 3. PR を作成する

`.github/PULL_REQUEST_TEMPLATE.md` のテンプレートを使って PR を作成する:

\`\`\`bash
git push -u origin HEAD
gh pr create --title "..." --body "$(cat <<'EOF'
## 概要
Closes #

## 変更内容
...

## チェックリスト
- [ ] テスト PASS（カバレッジ 80% 以上）
- [ ] 型チェック PASS
- [ ] フォーマット PASS
- [ ] カスタム静的解析 PASS（CRITICAL 0件）
- [ ] セキュリティ観点で確認済み（認証・認可・入力検証）

## テスト結果
EOF
)"
\`\`\`
```

#### `.claude/commands/audit-custom.md`

```markdown
---
name: カスタム静的解析
description: プロジェクト固有の静的解析を実行します
---

# /audit-custom

## 手順

### 1. スクリプトを実行する

\`\`\`bash
bash .github/scripts/audit-custom.sh
\`\`\`

### 2. 結果を確認する

- 終了コード 0: PASS
- 終了コード 1: CRITICAL 違反あり → 修正してから再実行

### 3. カスタマイズ方法

`.github/scripts/audit-custom.sh` に `docs/adr/` の決定事項に基づくチェックを追加する。

例（Laravel での認可チェック漏れ検出）:
\`\`\`bash
if grep -rn "public function" app/Http/Controllers/ | grep -v "Gate::\|can(\|authorize("; then
  echo "CRITICAL: 認可チェックなしのパブリックメソッドが存在します"
  ERRORS=$((ERRORS + 1))
fi
\`\`\`
```

---

