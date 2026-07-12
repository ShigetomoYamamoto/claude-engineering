# init-autonomous テンプレート: CLAUDE.md

> `/init-autonomous` のステップ4が読み込む生成テンプレート集。`{{ }}` を収集情報で
> 置換し、検出スタックに該当する分だけ生成する。元は `commands/init-autonomous.md` に
> 埋め込まれていたものを保守性のため外出し（ADR: テンプレート外出し / 要件 Issue #1）。

---

### 4-1. `CLAUDE.md`（プロジェクトルート）

以下の内容で生成する。`{{ }}` 内はステップ 1・2 の収集情報で置き換える:

```markdown
# {{ PROJECT_NAME }} — CLAUDE.md

## ドキュメント

{{ EXISTING_DOCS が空の場合 }}
| ファイル | 内容 |
|---------|------|
| `docs/01_product-specifications.md` | 目的・ユーザー・画面一覧・画面遷移 |
| `docs/02_detailed-design.md` | 各機能の詳細仕様・バリデーション・権限 |
| `docs/03_technical-requirements.md` | 技術スタック・依存ライブラリ・制約 |
| `docs/conventions.md` | 命名規則・コーディング規約 |
| `docs/adr/` | 設計上の重要判断の記録 |
| `docs/CODEMAPS/` | ファイル責務一覧 |

**実装前に必ず `docs/01_product-specifications.md` と `docs/02_detailed-design.md` を読むこと。**

{{ EXISTING_DOCS がある場合（既存資料のパスと種別をそのまま列挙） }}
| ファイル | 内容 |
|---------|------|
| `{{ EXISTING_DOCS の各パスを行として展開 }}` | {{ 種別 }} |
| `docs/conventions.md` | 命名規則・コーディング規約 |
| `docs/adr/` | 設計上の重要判断の記録 |
| `docs/CODEMAPS/` | ファイル責務一覧 |

**実装前に必ず上記ドキュメントを読むこと。**

## 技術スタック

{{ 検出したスタックを箇条書きで記載 }}

## フォルダ構成

{{ 検出したスタックの標準的なディレクトリ構成を記載 }}

## 絶対に守るルール

- 実装前に仕様書（`docs/01_` `docs/02_`）を必ず読む
- 全エンドポイントで認証・認可を確認する
- DB操作はトランザクションでラップする
- N+1 禁止：Eager Load を明示する
- `any` 禁止：型が不明な場合は `unknown` + 型ガードを使う
- テストは新機能・バグ修正で先行作成（TDD: RED → GREEN → REFACTOR）
- 1タスク = 1画面 or 1機能。スコープを超えない
- シークレットは環境変数で管理、コードにハードコードしない
- {{ CONSTRAINTS があれば追加 }}

## ドメインエンティティ

{{ DOMAIN_ENTITIES をリスト形式で記載 }}

## ユーザーロール

{{ USER_ROLES を記載。「認証なし」の場合はその旨 }}

## スラッシュコマンド

### 全自動モード（要件 → デプロイ）
| コマンド | 役割 |
|---------|------|
| `/requirements` | 要件分析（曖昧な要望を構造化要件に変換） |
| `/design` | システム設計（DB スキーマ・API コントラクト・技術選定） |
| `/plan` | 実装計画 |
| `/tdd` | テスト駆動開発で実装 |
| `/migrate` | DB マイグレーション実行 |
| `/deploy` | デプロイ + 検証 + 自動ロールバック |
| `/rollback` | 手動ロールバック |

### サポートモード（タスク → PR）
| コマンド | 役割 |
|---------|------|
| `/analyze-task` | タスク・課題・バグ報告を実装可能な単位に分解 |
| `/plan` | 実装計画 |
| `/tdd` | テスト駆動開発で実装 |
| `/respond-review` | PR レビューコメントへの対応 |

### 共通
| コマンド | 役割 |
|---------|------|
| `/code-review`（公式 `code-review` / `pr-review-toolkit`） | コードレビュー |
| `/commit-commands:commit`（公式 `commit-commands`） | コミット（規約は `commit-msg-convention` hook が担保） |
| `/create-pr` | PR 作成（base は develop 固定・自作） |
| `/build-fix` | ビルド・型エラーの修正 |
| `/test-coverage` | カバレッジ補完 |
| `/refactor-clean` | デッドコード削除 |
| `/e2e` | E2E テスト生成・実行 |
| `/update-docs` | ドキュメント同期 |
| `/update-codemaps` | コードマップ更新 |

### プロジェクト固有（このプロジェクトのみ）
| コマンド | 役割 |
|---------|------|
| `/precommit-check` | フォーマット・テスト・型チェック・静的解析を順番に実行 |
| `/audit-custom` | プロジェクト固有の静的解析を実行 |
```

---

