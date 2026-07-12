# init-autonomous テンプレート: .github/**（CI・PR/Issueテンプレ・dependabot・labeler）

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-6. `.github/`

#### `.github/workflows/ci.yml`

検出したスタックに応じて以下のジョブを並列実行する CI を生成する:

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
```

**Laravel 検出時のジョブ:**

```yaml
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
      - run: composer install --no-interaction
      - run: ./vendor/bin/pint --test

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          coverage: xdebug
      - run: composer install --no-interaction
      - run: ./vendor/bin/pest --coverage --coverage-clover=coverage.xml --min=80
      - name: Post coverage comment
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: composer audit
```

**Node.js 検出時のジョブ:**

```yaml
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint

  type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx tsc --noEmit

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run test -- --coverage
      - name: Post coverage comment
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high
```

**Python 検出時のジョブ:**

```yaml
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install ruff
      - run: ruff check . && ruff format --check .

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt pytest pytest-cov
      - run: pytest --cov --cov-fail-under=80 --cov-report=xml

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install pip-audit
      - run: pip-audit
```

**共通追加ジョブ（全スタック）:**

```yaml
  custom-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash .github/scripts/audit-custom.sh
```

#### `.github/scripts/audit-custom.sh`

```bash
#!/usr/bin/env bash
# プロジェクト固有の静的解析
# 終了コード: 0=OK, 1=CRITICAL 違反あり
set -euo pipefail

ERRORS=0

# ─────────────────────────────────────────────────────────────────
# CHECK 1: （プロジェクト固有ルールをここに追加）
# docs/adr/ の決定事項をコードで検証するチェックを書く
# ─────────────────────────────────────────────────────────────────

echo "カスタム静的解析: チェック未設定"
echo "docs/adr/ を参考にプロジェクト固有のバグパターンを追加してください"

if [ "$ERRORS" -gt 0 ]; then
  echo "❌ CRITICAL 違反: ${ERRORS} 件"
  exit 1
fi

echo "✅ カスタム静的解析: PASS"
exit 0
```

#### `.github/PULL_REQUEST_TEMPLATE.md`

```markdown
## 概要

<!-- 何を・なぜ変更したか -->

Closes #

## 変更内容

- [ ] 機能追加
- [ ] バグ修正
- [ ] リファクタリング
- [ ] ドキュメント
- [ ] CI / 設定変更

## チェックリスト

- [ ] テスト PASS（カバレッジ 80% 以上）
- [ ] 型チェック PASS
- [ ] フォーマット PASS
- [ ] カスタム静的解析 PASS（CRITICAL 0件）
- [ ] セキュリティ観点で確認済み（認証・認可・入力検証）

## テスト結果

<!-- カバレッジ出力を貼る -->
```

#### `.github/ISSUE_TEMPLATE/feature.yml`

```yaml
name: 機能追加
description: 新機能の追加リクエスト
title: "feat: "
labels: ["feature"]
body:
  - type: textarea
    id: description
    attributes:
      label: 機能の説明
    validations:
      required: true
  - type: textarea
    id: acceptance-criteria
    attributes:
      label: 受け入れ条件
    validations:
      required: true
  - type: textarea
    id: additional-context
    attributes:
      label: 補足情報
```

#### `.github/ISSUE_TEMPLATE/bug.yml`

```yaml
name: バグ報告
description: バグの報告
title: "fix: "
labels: ["bug"]
body:
  - type: textarea
    id: description
    attributes:
      label: 問題の説明
    validations:
      required: true
  - type: textarea
    id: reproduction
    attributes:
      label: 再現手順
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: 期待する動作
    validations:
      required: true
  - type: textarea
    id: environment
    attributes:
      label: 環境
```

#### `.github/dependabot.yml`

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
```

検出したスタックに応じて `npm` / `pip` / `composer` / `gomod` を追加する。

#### `.github/labeler.yml`

```yaml
backend:
  - changed-files:
    - any-glob-to-any-file:
      - 'app/**'
      - 'src/**/*.php'
      - 'src/**/*.py'
      - 'src/**/*.go'

frontend:
  - changed-files:
    - any-glob-to-any-file:
      - 'src/components/**'
      - 'src/pages/**'
      - 'src/app/**'
      - '**/*.tsx'
      - '**/*.vue'

migration:
  - changed-files:
    - any-glob-to-any-file:
      - 'database/migrations/**'
      - 'migrations/**'
      - 'alembic/**'

tests:
  - changed-files:
    - any-glob-to-any-file:
      - '**/*.test.ts'
      - '**/*.spec.ts'
      - '**/*_test.go'
      - 'tests/**'

ci:
  - changed-files:
    - any-glob-to-any-file:
      - '.github/**'
```

---

