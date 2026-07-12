---
name: git-workflow
description: Git workflow reference for commits, branching, and PRs. Covers Conventional Commits format, branch naming conventions, and PR description templates. Reference only — execution belongs to /create-branch, /create-pr, and /commit-commands:commit.
---

# Git Workflow Reference

## Conventional Commits

### Format

```
<type>: <description>

<optional body>
```

### Type table

| type | When to use |
|------|-------------|
| `feat` | 新機能の追加 |
| `fix` | バグ修正 |
| `refactor` | 機能変更を伴わないコード改善 |
| `docs` | ドキュメントのみの変更 |
| `test` | テストの追加・修正 |
| `chore` | ビルド設定・依存関係などの雑務 |
| `perf` | パフォーマンス改善 |
| `ci` | CI/CD 設定の変更 |
| `build` | ビルドシステム・外部依存の変更 |
| `style` | フォーマットなど、コードの意味に影響しない変更 |
| `revert` | 以前のコミットの取り消し |

### Rules

- description は**日本語**で「何をしたか」を端的に記述（50文字以内目安）
- 変更の背景や理由が非自明な場合は body に補足する
- Co-Authored-By 行は追加しない（Claude Code 既定では付与されるため、各マシンの settings で `includeCoAuthoredBy: false` を設定して機械的に無効化する。未設定のマシンでは手動で外す）

### Example

```
fix: 倉庫番ゲームで岩にキャラが重なる問題を修正

プレイヤーと岩の衝突判定が移動後の座標で行われていなかったため、
同一セルに重複配置されるケースを修正。
```

---

## Branch Naming

### Prefix table

| 目的 | Prefix | 説明 | Example |
|------|--------|------|---------|
| 新規追加 | `feature` | 新しい機能や画面の追加 | `feature/employee_csv_export_20251202` |
| 変更 | `update` | 既存機能の仕様変更・改善 | `update/salary_calculation_logic_20251202` |
| 修正 | `fix` | バグ修正・不具合対応 | `fix/night_shift_attendance_display_20251202` |
| 削除 | `remove` | 機能や要素の削除・非表示 | `remove/parent_company_alcohol_check_20251202` |
| リファクタリング | `refactor` | コード品質改善（機能変更なし） | `refactor/dashboard_service_20251202` |
| 緊急修正 | `hotfix` | 本番環境の緊急対応 | `hotfix/login_error_20251202` |

### Naming rules

1. Prefix は上記対応表に従う
2. 目的部分はスネークケース（snake_case）
3. 日付は YYYYMMDD 形式で末尾に付与
4. Format: `{prefix}/{summary}_{date}`

### AI judgment guide (when purpose is unclear)

- 「〜を追加する」「新しい〜を作る」→ `feature`
- 「〜を変更する」「〜を改善する」（バグ以外）→ `update`
- 「〜が動かない」「エラーが出る」「〜のバグ」→ `fix`
- 「〜を削除する」「〜を非表示にする」→ `remove`
- 「コードを整理」「リファクタリング」（機能変更なし）→ `refactor`
- 「緊急」「本番で〜」「至急対応」→ `hotfix`

---

## PR Description Template

```markdown
## Summary
- <変更点1>
- <変更点2>
- <変更点3（必要に応じて）>

## Test plan
- [ ] <確認項目1>
- [ ] <確認項目2>
- [ ] <確認項目3（必要に応じて）>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### Summary の書き方

- コミット履歴と差分から変更内容を箇条書きで3点程度にまとめる
- 「何を」「なぜ」変えたかを端的に記述する
- 技術的な詳細よりもレビュアーが理解しやすい説明を優先する

### Test plan の書き方

- 変更した機能・修正したバグに対して手動確認すべき項目を列挙する
- 「〜が正しく動作することを確認」という形式で記述する
