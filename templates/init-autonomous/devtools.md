# init-autonomous テンプレート: 開発ツール設定（eslint/prettier/tsconfig/ruff/husky/pre-commit/editor）

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-7. 開発ツール設定ファイル

スタックに応じて以下を生成する。既存ファイルがある場合は上書き前に確認する。

#### `eslint.config.js`（Node.js/TypeScript 検出時）

```js
import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': 'error',
      'no-console': 'warn',
    },
  },
]
```

#### `prettier.config.js`（Node.js 検出時）

```js
export default {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
}
```

#### `tsconfig.json`（TypeScript 検出時・存在しない場合のみ生成）

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

#### `pyproject.toml` への ruff 設定追加（Python 検出時）

既存の `pyproject.toml` がある場合はマージ、ない場合は新規作成する:

```toml
[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP"]
ignore = []
```

---

### 4-8. Git フック

#### Husky（Node.js 検出時）

`devDependencies` に `husky` がなければ追加してセットアップする。ユーザーに確認してから実行する:

```bash
npm install --save-dev husky lint-staged
npx husky init
```

`.husky/pre-commit` を生成する:

```bash
#!/bin/sh
npx lint-staged
```

`package.json` に `lint-staged` 設定を追加する:

```json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["prettier --write", "eslint --fix"],
    "*.{md,json,yml}": ["prettier --write"]
  }
}
```

#### pre-commit（Python 検出時）

`pre-commit` が未導入の場合はインストールを促す。`.pre-commit-config.yaml` を生成する:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.0
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format
```

---

### 4-9. エディタ設定

#### `.editorconfig`（全スタック）

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.php]
indent_size = 4

[*.py]
indent_size = 4

[Makefile]
indent_style = tab
```

#### `.vscode/extensions.json`（スタックに合わせて該当するものだけ含める）

```json
{
  "recommendations": [
    "EditorConfig.EditorConfig",
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "ms-vscode.vscode-typescript-next",
    "charliermarsh.ruff",
    "ms-python.python",
    "bmewburn.vscode-intelephense-client",
    "onecentlin.laravel-blade"
  ]
}
```

#### `.vscode/settings.json`（スタックに合わせて生成）

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff"
  },
  "[php]": {
    "editor.defaultFormatter": "bmewburn.vscode-intelephense-client"
  }
}
```

---

