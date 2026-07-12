---
description: |
  新プロジェクトに AI エージェント自走のための環境基盤を一括生成します。
  スタック自動検出 → 情報収集 → ツール整備 → CLAUDE.md / .claude / docs / .github を生成
---

# /init-autonomous — 自律開発基盤セットアップ

このコマンドは任意のプロジェクトディレクトリで実行すると、AIエージェントが自走して開発を完成させるための環境基盤を一括生成します。

**解決する問題:**
1. **止まる** → 確認が必要・仕様が曖昧
2. **間違える** → 判断基準がない・設計意図がわからない
3. **壊れたまま進む** → 品質チェックが自動化されていない

---

## ステップ 1: 既存ファイルからスタックを自動検出

カレントディレクトリで以下のファイルを順に確認し、技術スタックを特定する。

**検出ルール:**
- `composer.json` が存在 → PHP を確認。`laravel/framework` 依存があれば Laravel
- `package.json` が存在 → Node.js 系。`dependencies` / `devDependencies` を読んで特定:
  - `next` → Next.js（`appDir` 設定があれば App Router、なければ Pages Router）
  - `nuxt` → Nuxt
  - `react` のみ → React（CRA / Vite / etc）
  - `vue` のみ → Vue
  - `express` / `fastify` / `hono` → Node.js バックエンド
- `requirements.txt` または `pyproject.toml` が存在 → Python。内容を確認:
  - `django` → Django
  - `fastapi` → FastAPI
  - `flask` → Flask
- `go.mod` が存在 → Go
- `Cargo.toml` が存在 → Rust
- `build.gradle` または `pom.xml` が存在 → Java/Kotlin

複数検出した場合はフロントエンド・バックエンドに分けて認識する（例: Next.js + Laravel）。

**スタック検出変数として以下を内部で保持する（以降のステップで参照）:**
- `STACK_FRONTEND`: 検出結果（例: `nextjs`, `react`, `vue`, `nuxt`, なし）
- `STACK_BACKEND`: 検出結果（例: `laravel`, `django`, `fastapi`, `express`, `go`, `rust`, なし）
- `USES_TYPESCRIPT`: `tsconfig.json` が存在するか、または package.json に `typescript` があれば `true`
- `TEST_FRAMEWORK`: 後述の情報収集で決定

何も検出できない場合はステップ 2 の質問 0 として「使用技術スタックを教えてください」を先頭に追加する。

---

## ステップ 2: 最小限の情報収集（最大5問）

ファイルから推測できた項目は省略してよい。質問はまとめて一度に提示し、ユーザーの回答を待つ。

**質問リスト（該当するものだけ聞く）:**

1. **プロジェクト名と一行説明**（例: `recipe-cost` — 飲食店向けレシピ原価管理ツール）
   - `package.json` の `name` / `description` や `composer.json` から推測できる場合は省略し、推測値を提示して確認のみ行う

2. **主要ドメインエンティティ 3〜5個**（例: ユーザー・商品・注文・在庫）
   - DBマイグレーションファイルやモデルディレクトリが存在する場合は既存ファイル名から推測して提示する

3. **ユーザーロール構成**（例: `admin / editor / viewer`。認証なしなら「なし」）
   - ミドルウェアや Policy ファイルから推測できる場合は提示する

4. **テストフレームワーク**（未確定なら推奨を提示して確認）
   - Laravel → Pest を推奨
   - Next.js / React → Vitest を推奨
   - Python → pytest を推奨
   - Go → 標準 `testing` パッケージ + testify を推奨

5. **特に避けたいライブラリや制約**（なければスキップ）

6. **既存の仕様書・設計書**（なければスキップ）
   - 既存資料がある場合はファイルパスを教えてください
   - 例: `仕様書: docs/spec.md、設計書: docs/architecture.md`
   - 複数ある場合はすべて列挙してください

収集した情報を以下の変数として保持する（以降のステップで参照）:
- `PROJECT_NAME`: プロジェクト名（スラッグ形式）
- `PROJECT_DESCRIPTION`: 一行説明
- `DOMAIN_ENTITIES`: エンティティリスト
- `USER_ROLES`: ロール構成（なければ「認証なし」）
- `TEST_FRAMEWORK`: 確定したテストフレームワーク
- `CONSTRAINTS`: 制約事項（なければ空）
- `EXISTING_DOCS`: 既存資料のパスと内容の種別（なければ空）

---

## ステップ 3: ツール・環境の整備

検出したスタックに基づき、プロジェクトに必要なツールを特定する。次に、マシン上の導入状況を確認し、**未導入のものだけ**を導入または案内する。

### 3-A: 必要なツールの特定

スタックに応じて以下のリストを構築する:

**共通（全スタック）:**
- `git`
- `gh`（GitHub CLI）

**PHP/Laravel 検出時:**
- `php` 8.2 以上、`composer`
- `./vendor/bin/pint`・`./vendor/bin/pest`（`composer install` で自動導入）

**Node.js 系検出時:**
- `node` 20 以上
- パッケージマネージャー（`package.json` の `packageManager` フィールドで判定: `npm` / `pnpm` / `yarn`）
- `eslint`・`prettier`・テストフレームワーク（`TEST_FRAMEWORK` 変数を参照）

**TypeScript 検出時:** `typescript`

**Python 検出時:** `python` 3.11 以上、`pip`・`ruff`・`pytest`・`pytest-cov`

**Claude Code — MCP（スタック別）:**

| 条件 | 追加する MCP |
|-----|------------|
| `playwright` が依存にある | Playwright MCP |
| `@supabase/` が依存にある | Supabase MCP |
| `vercel.json` または Vercel 関連ファイルがある | Vercel MCP |

**Claude Code — Plugins（スタック別）:**

| 条件 | 案内する Plugin |
|-----|--------------|
| `.github/` を生成する（ほぼ常時） | GitHub Plugin（公式。`/plugin` で導入し `GITHUB_PERSONAL_ACCESS_TOKEN` を設定。[ADR-011](../docs/adr/011-official-github-plugin.md)）|
| `@supabase/` が依存にある | Supabase Plugin |
| `vercel.json` または Vercel 関連ファイルがある | Vercel Plugin |
| 環境変数に `SLACK_` が含まれる | Slack Plugin |

**Claude Code — Skills（スタック別）:**

ステップ 4 の `.claude/commands/` 生成に加え、スタック別の既存 Skills を案内する:

| 条件 | 案内する Skill |
|-----|-------------|
| Vercel 関連ファイルがある | `vercel:deploy`・`vercel:env`・`vercel:status` |
| Supabase 依存がある | `supabase:supabase` |
| Slack 環境変数がある | `slack:standup`・`slack:find-discussions` |

### 3-B: マシン上の導入状況を確認

各 CLI ツールを `command -v` で確認する:

```bash
command -v git && git --version
command -v gh && gh --version
command -v node && node --version
command -v python3 && python3 --version
command -v ruff && ruff --version
```

Node.js パッケージは `package.json` の `devDependencies` に記載があれば「導入予定」とみなし、`node_modules/` が存在しない場合のみインストール対象とする。

PHP の `pint` / `pest` は `vendor/` 配下に存在するか確認する。

Claude Code の MCP は `.mcp.json`（プロジェクト）と `~/.claude.json`（グローバル）の両方を確認し、どちらにも設定がなければ対象とする。

### 3-C: 未導入ツールのインストール

未導入のツールを **まとめてリストアップしてユーザーに一括確認** してからインストールを実行する。1ツールずつ聞かない。

**Node.js パッケージ（`node_modules/` がない場合）:**
```bash
npm install   # または pnpm install / yarn install
```

**Node.js 開発ツール（`devDependencies` に未記載の場合）:**
```bash
npm install --save-dev eslint prettier vitest @vitest/coverage-v8
# TypeScript の場合は追加
npm install --save-dev typescript @types/node tsx
```

**Python ツール（未導入の場合）:**
```bash
pip install ruff pytest pytest-cov
```

**gh CLI（未導入の場合）:**
システムへの影響が大きいため自動インストールしない。インストールコマンドを提示してユーザーに実行を促す:
```
# macOS
brew install gh
# Linux (Ubuntu/Debian)
sudo apt install gh
```

### 3-D: Claude Code MCP の設定

未設定の MCP サーバーをプロジェクトルートの `.mcp.json` に追加する。既存の `.mcp.json` がある場合はマージする（上書きしない）。

以下の python3 コマンドで生成する:

```bash
python3 << 'PYEOF'
import json, os

# 検出結果に応じて追加するサーバーを構築（不要なものは除く）
# 注: GitHub は MCP に直書きせず、公式 `github` プラグイン（/plugin）で導入する（ADR-011）
new_servers = {
    # playwright が依存にある場合は追加:
    # "playwright": {
    #     "type": "stdio",
    #     "command": "npx",
    #     "args": ["@playwright/mcp@0.0.76"],
    #     "env": {}
    # },
}

path = ".mcp.json"
existing = {}
if os.path.exists(path):
    with open(path) as f:
        existing = json.load(f)

servers = existing.get("mcpServers", {})
added = []
for name, config in new_servers.items():
    if name not in servers:
        servers[name] = config
        added.append(name)

existing["mcpServers"] = servers
with open(path, "w") as f:
    json.dump(existing, f, indent=2)

print(f"✓ .mcp.json を更新しました（追加: {added}）")
PYEOF
```

### 3-E: Claude Code Plugins の案内

未導入の Plugin を検出した場合、インストール方法をまとめて出力してユーザーに案内する（自動インストールはしない）:

```
📦 以下の Claude Code Plugin の導入を推奨します（未インストールのもの）:

【共通・本リポジトリ方針（ADR-012）】公式 claude-plugins-official から `/plugin` で導入:
- commit-commands   — コミット / ブランチ掃除（/commit-commands:commit・clean_gone）
- pr-review-toolkit — コードレビュー（code-reviewer ほか専門エージェント群）
- security-guidance — 編集時警告＋commit 時 LLM セキュリティレビュー

【スタック別】
- Supabase Plugin: claude mcp add supabase ...
- Vercel Plugin:   claude mcp add vercel ...

共通3種は生成した .claude/settings.json の enabledPlugins で有効化済み（本体導入は各メンバーが /plugin で行う）。
インストール後、/init-autonomous を再実行するか .mcp.json に手動で追記してください。
```

### 3-F: 推奨 Skills の案内

プロジェクトに関連する既存 Skills をまとめて案内する（スタック別に該当するものだけ表示）:

```
🛠️  このプロジェクトで使える Skills:
- /vercel:deploy      — Vercel へのデプロイ
- /vercel:env         — 環境変数の管理
- /supabase:supabase  — Supabase 操作全般
- /slack:standup      — Slack スタンドアップ生成
```

---

## ステップ 4: ファイルを一括生成

既存ファイルがある場合は **上書き前に確認する**。それ以外は人間の追加入力なしに生成を進める。

---

### 4-0. `.claude/settings.json`（プロジェクト固有の権限設定）

検出したスタックに応じて、`auto` モードで確認なしに実行できるコマンドを定義する。
**git は グローバル設定で `Bash(git *)` / `Bash(gh *)` として許可済みのため含めない。**

以下の手順で生成する（複数スタック検出時は `allow` 配列を自動マージ）:

**Step 1: `/tmp/` に生成**（検出スタックに合わせてコメントアウトを解除すること）

```bash
python3 << 'PYEOF'
import json, os

# 検出されたスタックに応じてコメントアウトを解除する
STACK_PERMISSIONS = {
    # "nodejs": [  # package.json 検出時
    #     "Bash(npm run *)", "Bash(npm ci)", "Bash(npm install *)",
    #     "Bash(npx *)", "Bash(node *)", "Bash(pnpm *)", "Bash(yarn *)",
    # ],
    # "laravel": [  # composer.json + artisan 検出時
    #     "Bash(php artisan *)", "Bash(composer *)",
    #     "Bash(./vendor/bin/pest *)", "Bash(./vendor/bin/pint *)",
    # ],
    # "python": [  # requirements.txt / pyproject.toml 検出時
    #     "Bash(python *)", "Bash(python3 *)", "Bash(pip install *)",
    #     "Bash(pytest *)", "Bash(ruff *)", "Bash(uvicorn *)", "Bash(gunicorn *)",
    # ],
    # "go": [  # go.mod 検出時
    #     "Bash(go build *)", "Bash(go test *)", "Bash(go run *)",
    #     "Bash(go mod *)", "Bash(go vet *)",
    # ],
    # "rust": [  # Cargo.toml 検出時
    #     "Bash(cargo build *)", "Bash(cargo test *)", "Bash(cargo run *)",
    #     "Bash(cargo clippy *)", "Bash(cargo fmt *)",
    # ],
}

existing = {}
if os.path.exists(".claude/settings.json"):
    with open(".claude/settings.json") as f:
        existing = json.load(f)

current_allow = existing.get("permissions", {}).get("allow", [])
new_allow = [p for perms in STACK_PERMISSIONS.values() for p in perms]
merged = list(dict.fromkeys(current_allow + new_allow))

if "permissions" not in existing:
    existing["permissions"] = {}
existing["permissions"]["allow"] = merged
existing["defaultMode"] = "auto"

# 公式プラグインを有効化（git/レビュー/セキュリティは公式に委譲・ADR-012）。
# 本体導入は各メンバーが /plugin で行う（enabledPlugins は有効化フラグ）。
existing["enabledPlugins"] = {
    **existing.get("enabledPlugins", {}),
    "commit-commands@claude-plugins-official": True,
    "pr-review-toolkit@claude-plugins-official": True,
    "security-guidance@claude-plugins-official": True,
}

with open("/tmp/claude_settings.json", "w") as f:
    json.dump(existing, f, indent=2)

print(f"✓ /tmp/claude_settings.json を生成しました（allow: {len(merged)} 件 / plugins: {len(existing['enabledPlugins'])} 件）")
PYEOF
```

**Step 2: プロジェクトに配置**

```bash
mkdir -p .claude && cp /tmp/claude_settings.json .claude/settings.json && echo "✓ .claude/settings.json を配置しました"
```

cp がブロックされた場合はユーザーに以下を実行してもらう:

```
! mkdir -p .claude && cp /tmp/claude_settings.json .claude/settings.json
```

---

### 4-1〜4-11. 各種ファイルのテンプレート生成

生成するファイルの中身は、保守性のためカテゴリ別テンプレート集へ外出しした
（`~/.claude/templates/init-autonomous/`）。各テンプレートを読み、`{{ }}` プレースホルダを
ステップ1・2の収集情報で置換し、**検出スタックに該当する分だけ**生成する。各カテゴリ内の条件
（「Laravel 検出時」等）はテンプレート内の見出しに従う。既存ファイルは上書き前に確認する。

| カテゴリ | テンプレート | 主な生成先 |
|---|---|---|
| CLAUDE.md | `templates/init-autonomous/claude-md.md` | `CLAUDE.md` |
| ルール | `templates/init-autonomous/rules.md` | `.claude/rules/*.md`（スタック別） |
| コマンド | `templates/init-autonomous/commands.md` | `.claude/commands/*.md` |
| エージェント | `templates/init-autonomous/agents.md` | `.claude/agents/*.md`（code-reviewer は公式 `pr-review-toolkit` に委譲） |
| ドキュメント | `templates/init-autonomous/docs.md` | `docs/**`（仕様/設計/ADR/CODEMAPS/playbooks） |
| GitHub | `templates/init-autonomous/github.md` | `.github/**`（CI/PRテンプレ/Issueテンプレ/dependabot/labeler） |
| 開発ツール設定 | `templates/init-autonomous/devtools.md` | eslint/prettier/tsconfig/ruff/husky/pre-commit/editorconfig/vscode |
| プロジェクト側hook | `templates/init-autonomous/project-hooks.md` | `.claude/settings.json` 配線＋`.claude/hooks/debug-output-detector.py`＋スタック別品質ガード |

## ステップ 5: 残タスクを出力して終了

生成完了後、以下の形式で出力する:

```
✅ 自動生成完了（{{ 生成したファイル数 }} ファイル）

📝 次にあなたがやること（この順番で）:

【最優先：仕様書】
1. docs/01_product-specifications.md を書く
   → 画面一覧・画面遷移・主要ユーザーストーリー

2. docs/02_detailed-design.md を書く
   → 各機能の入力項目・バリデーションルール・権限・保存ロジック

【設計の記録】
3. docs/adr/ に設計上の重要な判断を記録する（1決定 1ファイル）
   → 「なぜこのフレームワークか」「なぜこのDB設計か」等
   → ADR-000-template.md をコピーして番号付きで作成する

【静的解析のカスタマイズ】
4. .github/scripts/audit-custom.sh にプロジェクト固有のチェックを追加する
   → ADR で決定した制約をコードで検出するルールを書く

【仕上げ】
5. CLAUDE.md の「絶対ルール」を実際の制約に合わせて調整する
6. docs/CODEMAPS/ をコード実装が進んだら随時更新する

⚠️  2, 3, 4 が薄いほどエージェントの判断品質が下がります
   仕様書が空のままエージェントに実装を依頼すると、仮定だらけのコードが生成されます

生成したファイル一覧:
{{ 生成したファイルのパスをリスト形式で出力 }}
```
