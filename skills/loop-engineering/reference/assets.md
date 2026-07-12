# loop-engineering 連携資産(役割分担・重複させない)

`loop-engineering` スキルが委譲・参照する資産と、その境界。

| 資産 | 種別 | 役割 | このスキルとの関係 |
|---|---|---|---|
| **loop-engineering**(本スキル) | skill | 前段(VISION/観点/レッド・グリーン)+ 指揮 + 完了判定 | オーケストレータ。往復は自作せず委譲。VISION 照合と verify は自分で行う。 |
| **loop-engineering-large-A** | **workflow** | A-大の 計画(fan-out)→赤確認→実装→verify を決定的に回す | A-大のときだけ。`mode:plan`(草案)→人間承認→`mode:execute`(実装〜検証)。レビューは含めず /review-loop に委譲。 |
| **/review-loop** | **command** | レビュー→修正を指摘0まで自動往復 | STEP 5 を委譲。`/review-loop [最大回数]`。 |
| **/review-loop-cross** | **command** | 別モデル(Codex)がレビュー(未コミット差分が対象) | クロスレビュー希望時。外部 CLI 副作用は要確認。 |
| **/review-loop-cross-path** | **command** | 別モデルが指定パスを丸ごと(非 git 可) | `<path>` 必須・既定上限 2。 |
| **reviewer** | agent | 厳格コードレビュー専任(CRITICAL/HIGH か NO_ISSUES) | /review-loop が中で起動。再定義しない。 |
| **fixer** | agent | 指摘を1件ずつ最小修正、verify で exit 0 確認 | /review-loop が中で起動。再定義しない。 |
| **3-line-contract** | skill | 目的/出力/成功条件を 3 行に整理 | 目標が曖昧なときの前段。 |
| **/commit-commands:commit ・ /create-pr** | command | コミット(公式) / PR 作成(自作) | 完了後フロー(明示依頼があってから)。push はユーザー手動(`~/.claude/rules/git-workflow.md`)。 |
| **testing.md / answer-only.md** | グローバル方針 | レッド→グリーン/ミューテーション、明示依頼まで読み取り専用 | STEP 4 と全体の前提として従う。 |
| **rules/loop-safety.md** | グローバル方針 | 自走の安全規律(ハードストップ・ゴールドリフト・不可逆操作確認)の正本 | 往復上限・破壊的操作確認の数値の正本。本スキルが参照(独立した二重ブレーキ)。 |
| **rules/memory.md** | グローバル方針 | ラン間学習(2回出た指摘を memory に昇格) | 同じ指摘の再発防止(アウターループ)。 |
| **rules/parallel-worktree.md** | グローバル方針 | 並列ライターの worktree 隔離 | large-A の並列実装時の隔離規範。 |
