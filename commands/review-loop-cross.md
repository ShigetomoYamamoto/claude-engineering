---
description: レビュー→修正を指摘0まで自動ループ。レビューは別モデル(Codex/GPT CLI)が担当し、SCOPE は未コミットの git 差分に固定。maker(Claude)と checker(別モデル)をモデルレベルで分離する。
argument-hint: [最大イテレーション数 (デフォルト: 5)]
---

別モデル(Codex/GPT)にレビューさせる review-loop。**maker(Claude の fixer)と checker(別モデル)をモデルレベルで分離**し、同一モデルの盲点を相互に補う。修正は Claude の `fixer` が担当する。

**SCOPE は未コミットの git 差分に固定**します(`git diff HEAD`)。非 git リポジトリ・差分が無い場合は使えません → その場合は `/review-loop-cross-path <path>` を使う。

> ⚠️ 外部 CLI(codex)を実行し、ネットワーク通信・外部サービス利用量(課金)が発生する副作用があります。起動時に利用者へ一度確認してから回してください(answer-only の精神)。

# 前提確認(ループ開始前に1回)

1. **codex CLI の存在確認**: `command -v codex`。無ければ「codex CLI が未インストールのため cross レビューは使えません。通常の `/review-loop` を使ってください」と案内して停止。
2. **差分の存在確認**: `git diff HEAD` が空でないこと。空なら「未コミット差分がありません」と案内して停止。
3. **利用者への確認**: 外部モデル(課金・通信)を使う旨を伝え、承認を得てから開始。

# 初回セットアップ(ループ開始前に1回)

親(オーケストレータ)が以下を保持する(`review-loop` と同型。違いは checker が外部 CLI な点):

- **SCOPE**: 未コミット差分(`git diff HEAD`)。固定。
- **FOCUS**: 重点観点(任意。例「セキュリティ重点」)。無ければ reviewer デフォルト観点。
- **REVIEW_HISTORY / FIX_HISTORY**: 空配列で初期化。

# 実行ループ

最大イテレーション `$ARGUMENTS`(既定 **5**)を **MAX**、カウンタを **N**(1 から)とする。

## ステップ1: レビュー(別モデル)

未コミット差分を外部モデルに渡してレビューさせる:

```bash
git diff HEAD > /tmp/review-cross-diff.patch
codex exec "あなたは厳格なシニアコードレビュアー。次の git diff をレビューし、CRITICAL/HIGH の問題のみを『[重大度] [ファイル:行] 要約 / 影響 / 修正方針』形式で列挙せよ。HIGH 以上が無ければ NO_ISSUES の1行のみ出力。MEDIUM/LOW は出力しない。--- $(cat /tmp/review-cross-diff.patch)"
```

> codex の正確な起動方法は環境の CLI 仕様に合わせる。**出力契約は `~/.claude/agents/reviewer.md` と同一**にすること(CRITICAL/HIGH のみ・無ければ `NO_ISSUES` 1行)。フォーマットが異なる場合は親が CRITICAL/HIGH と NO_ISSUES を抽出して正規化する。

出力を `CURRENT_REVIEW` として保持。

## ステップ2: 終了判定

- `CURRENT_REVIEW` が `NO_ISSUES` のみ → ✅ 成功として終了(最終報告へ)
- 指摘あり → ステップ3

## ステップ3: 重複指摘の検知

`N >= 2` かつ `CURRENT_REVIEW` と `REVIEW_HISTORY[-1]` が本質的に同じ指摘で2連続 → 「修正困難」として停止(最終報告へ)。

## ステップ4: 修正(Claude の fixer)

`REVIEW_HISTORY` に `CURRENT_REVIEW` を追加してから、Task ツールで `fixer` サブエージェント(`~/.claude/agents/fixer.md`)を起動。プロンプト先頭に引き継ぎコンテキスト(SCOPE・FIX_HISTORY)を置く。fixer の出力(修正ファイル+概要)を `FIX_HISTORY` に追加。

## ステップ5: 進捗報告

```
[N回目] レビュー(外部モデル)指摘 X 件 → 修正完了 (累積修正ファイル: Y 件)
```

## ステップ6: ループ継続

N をインクリメントしてステップ1へ。

# 終了条件・最終報告

`/review-loop` と同じ(✅ NO_ISSUES / ⚠️ 上限到達 / ⚠️ 同一指摘2連続)。報告に **「レビュー担当: 外部モデル(codex)」** を明記する。

# 注意

- **レビュー=外部モデル、修正=Claude の fixer** の分業を厳守。
- 安全規律(往復上限・破壊的操作の毎回確認・完了条件の改竄禁止)の正本は `~/.claude/rules/loop-safety.md`。本コマンドの往復上限はそのハードストップ(ターン/時間)とは独立した二重ブレーキで、**いずれか先に到達した方で停止**する。
