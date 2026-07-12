---
description: |
  コード変更を「レビュー→指摘の独立検証→修正→再レビュー」と、
  CRITICAL/HIGH が 0 になるか上限到達まで自律で回します（Workflow 使用）。
---

# /verify-loop — 自律検証ループ

`code-reviewer` / `security-reviewer` の「CRITICAL が 0 になるまで繰り返す」を、人間の判断を挟まずに回す。検出 → 検証 → 修正を `Workflow` のパイプラインで自律実行する。

> **位置づけ（`/review-loop` との使い分け）:** コード1タスクの通常の磨き込みは層1の **`/review-loop`**（reviewer/fixer）に委譲する（autorun の verify フェーズもこれ）。本コマンドは **反証的多数決検証つきの上位変種**で、セキュリティ重視・誤検知を厳しく排除したい時にだけ使う。**自走（`/autorun`）の verify ゲートではない**（それは `/review-loop`）— 本コマンドは手動起動の任意変種(ADR-014 / 監査 P7)。

## 前提（`rules/loop-safety.md` 準拠）

`rules/loop-safety.md` の Preconditions をすべて満たすこと。本コマンド固有の定義:

- **1ラウンド** = 「検出 → 検証 → 修正 → 再判定」の1巡（下記ループ構造の1周）
- **ハードストップ**: 既定で最大5ラウンド。これに加え loop-safety のターン / 時間上限も併用する（膠着・暴走対策）
- **成功条件**: CRITICAL=0 かつ HIGH=0 かつ テスト / lint / 型チェックが pass

## ループ構造（Workflow）

各ラウンドで以下を回す:

1. **Review（検出）** — 変更ファイルを `code-reviewer` と `security-reviewer` で並列レビューし、指摘を severity 付きで集約する。
2. **Verify（検証）** — 各 CRITICAL / HIGH 指摘を**独立した3エージェント**で反証的に検証する（「本当に問題か / 誤検知では」）。**3中2以上**が「実在」とした指摘だけ残す。検証エージェントは read-only（修正と同時実行しないため worktree 隔離は不要）。
3. **Fix（修正）** — 残った指摘を最小差分で修正する（build-error-resolver の方針）。
4. **再判定** — テスト / lint / 型チェックを実行する。

## 終了条件（いずれか）

- CRITICAL=0 かつ HIGH=0 かつ 機械チェック pass（成功）
- ラウンド上限（既定5）または loop-safety のターン / 時間上限に到達（未達 → 残指摘を報告して停止）
- 2ラウンド連続で新規指摘ゼロかつ未修正が残る（膠着 → 報告して停止）

## 不可逆操作

- このループ内では commit / push を行わない。終了後に通常の `/commit-commands:commit` → `/create-pr` へ渡す。

## 関連

- `rules/loop-safety.md` — ハードストップとゴールドリフト対策（前提の唯一の正）
- `rules/memory.md` — 2回出た指摘は memory に昇格させ再発を止める
- `code-reviewer`（公式 `pr-review-toolkit` プラグイン）/ `agents/security-reviewer.md`（自作・維持）— 検出・検証に使うエージェント
