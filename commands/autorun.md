---
description: |
  目的を渡すと autorun-flow.md の定義に従い、完了条件まで関門4点以外を自動連結して自走します。
  関門(要件確定/設計確定/PR作成/デプロイ)と不可逆操作でのみ人間が確認します。
argument-hint: "[--vibing] <目的またはタスク/Issue>"
---

# /autorun — 自走モード（関門付きフロー自走インタープリタ）

目的を1つ渡すと、`.claude/docs/autorun-flow.md`（フロー定義）を解釈し、完了条件まで人間のコマンド
打鍵なしでフェーズを自動連結する。関門4点と不可逆操作でのみ停止する。安全規律の正本は
`rules/loop-safety.md`。

## ステップ 1: 起動時チェック

1. **Preconditions** — `rules/loop-safety.md` の前提条件を満たすか確認。
2. **機械検証可能性の前倒し** — 通る全 auto フェーズ（autorun-flow.md）の success_test が
   このプロジェクトで機械検証可能か（test / lint / typecheck コマンドの実在）を Bash で検出。
   1つでも不能なら「自走不可・不足を報告」して停止。あわせて **remote CI（`.github/workflows`
   の PR/push トリガ）の実在も検出**し、あれば pr の success_test に CI green を必須化する。
   無ければ CI 待ちを skip し「CI 未検出のため CI green チェックなし」を transcript にログする
   （沈黙させない・ADR-018）。
3. **専用ブランチ確認** — `main`/`master`/`develop` なら先に `/create-branch`（`rules/agents.md`
   の Pre-Implementation Branch Check）。develop 不在なら現作業ブランチ、protected なら新規分岐。
4. **ハードストップ設定** — 未指定なら全行程の既定（遷移回数上限 ＋ 20ターン/30分）を提示し合意。
5. **commit 包括承認** — 「自走中、関門以外の commit を確認なしで自動実行してよいか」を1回だけ
   確認し承認を得る（`rules/git-workflow.md` の自走時例外）。承認が得られなければ commit を
   gate 扱いにする。
6. **`--vibing` フラグ受理（任意）** — 付いていれば RUN_STATE.vibing=true。vibing は方向ゲート
   （要件・条件付き設計）と巻き戻し不能操作以外の事前確認を外すモード。起動時に「PR push と巻き戻し
   可能な deploy の事前確認を外す（巻き戻し不能操作は確認を残す）」旨を1回提示し合意を取る。降格規則・
   ハードストップ値の正は `.claude/docs/autorun-flow.md`「vibing demotion rules」、安全規律は
   `rules/loop-safety.md` を参照（本コマンドに定義実体は置かない・ADR-015）。`--isolation`（任意の
   安全ダイヤル・既定 none）も受理する。

## ステップ 2: モード判定

入力が自由形式の目標 → full-auto / 具体タスク・Issue → support。autorun-flow.md のモード表から
start / goal を取得する。`--vibing` は第3モードではなく、full-auto / support どちらにも重畳する
直交フラグ（ADR-015）。

## ステップ 3: RUN_STATE 初期化（会話内に可視化）

`RUN_STATE = { mode, current_phase, goal_phase, phase_outputs, gates_passed, budget, branch, commit_blanket_approved, vibing, design_needed, isolation }`
を初期化し transcript に表示する（loop-safety の「全ステップを出す」準拠）。`vibing` / `design_needed`
/ `isolation` は vibing 用（無印では vibing=false で従来どおり）。肥大化したら直近 1-2 フェーズ重視で
要約圧縮する（`commands/review-loop.md` の引き継ぎ規律に倣う）。

## ステップ 4: 反復ループ

current_phase が goal_phase を越えるまで繰り返す:

1. `.claude/docs/autorun-flow.md` を読み、current_phase の行を引く。
2. 実行部品を起動する（GOAL 再掲・直前フェーズ成果・SCOPE をプリアンブルで明示的に渡す）。
   - **tdd** フェーズは `skills/loop-engineering/`（ミクロ層）に委譲（渡した SCOPE を採用させ、STEP0 の A/B/C 再判定はさせない＝判断者1人。`.claude/docs/autorun-flow.md`「Scope handoff to the tdd phase」）。
   - **verify** フェーズは `/review-loop` に委譲。
3. success_test を**機械的に実行**（Bash、結果を transcript 出力。自己申告で代替しない）。
4. 偽なら: フェーズ内リトライ（tdd/verify は内部ループ、build エラーは build-error-resolver）。
   フェーズ内上限 or 膠着で STOP・報告。
5. 真なら kind 分岐:
   - vibing 時は分岐の**直前に `resolve_kind(phase, RUN_STATE)` を適用**し、降格後の kind で分岐する
     （導出規則の正は `.claude/docs/autorun-flow.md`「vibing demotion rules」。評価結果は transcript に出す）。
   - **auto** — 確認を取らず next へ自動遷移。commit フェーズは包括承認のもと自動（メッセージは提示）。
   - **gate** — 停止プロトコル（関門名・成果サマリ・次に進むと何が起きるか・承認/修正/中止を提示し
     **能動的にターン終了**）。承認後のみ next。承認は gates_passed に記録し次に持ち越さない。
6. **design スキップ** — autorun-flow.md のスキップ条件（requirements 成果の `design_needed` で判定）を
   満たせば design gate ごとスキップして plan へ。vibing も同じ `design_needed` を使う（新基準は設けない）。
7. **ゴールドリフト検知** — 各フェーズ境界で (a) 構造ゴール=goal_phase 到達、(b) 内容ゴール=確定要件
   への各成果の写像、の両方を確認。内容がズレたら新目標を作らず STOP・報告。
8. **PR 作成後の CI 待ち（pr フェーズ・merge 前）** — `pr` の success_test には機械成分「remote CI green」が
   ある（CI 実在時・起動時チェックで判定）。PR を push したら CI が起動するので、前進（full-auto は migrate へ）
   または共有ブランチへの merge の前に `gh run watch <run-id> --exit-status`（または `gh pr checks <pr> --watch`）
   で green を機械確認する。**green → 前進。赤 / タイムアウト / run 検出不能 → STOP・報告（fail-safe=停止）**。
   これは「手続き＋機械チェック」で担保し物理層（hook）は無い（過大表示しない）。**vibing でもこの機械確認は
   外れない**（vibing が外すのは PR 承認の事前確認＝人間ゲートだけ。正は `.claude/docs/autorun-flow.md`「Remote CI
   green は pr の機械 success_test 成分」、`docs/adr/018-remote-ci-as-done-condition.md`）。

## ステップ 5: 停止と報告

ゴール到達 / 関門待ち / ハードストップ / 異常停止のいずれかで停止し、停止区分を明示する。
**止まってよい場所のホワイトリスト**（autorun-flow.md）以外で止まったら定義違反として検知・報告。
`rules/memory.md` に従い「次回が知るべき学習」を `memory/` に書き戻してから報告する。

## 不可逆操作（loop-safety 準拠）

- push / deploy / delete / 外部送信は自走中でも人間確認（関門 pr / deploy がこれを担う）。
- 共有ブランチ（develop/main）への merge は **head の remote CI green を機械確認してから**行う（赤/未完了/検出不能は
  停止・fail-safe）。CI 待ちは手続き＋機械チェックで担保し物理層は無い（ADR-018・`rules/loop-safety.md`）。
- push / PR は **gh CLI（Bash）経由**で行い、物理層の `pr-base-checker.py` /
  `git-destructive-blocker.py` が効くようにする（MCP 経由は物理層が抜けるため避ける）。
- **vibing 時（ADR-015）**: 巻き戻し**可能**な不可逆操作（PR push・auto-rollback 可能な deploy）の
  事前確認を外し、事後監査＋auto-rollback＋transcript 記録に置換する。巻き戻し**不能**な操作（外部送信・
  破壊的 migrate・rollback 不能 deploy）は確認を残す（fail-safe=gate）。vibing の PR→main は gh CLI に
  vibing マーカーを付けて `pr-base-checker.py` の例外を通す。詳細の正は `rules/loop-safety.md`。

## 関連

- `.claude/docs/autorun-flow.md` — フロー定義（本コマンドが解釈する正）
- `rules/loop-safety.md` — 安全規律の正本
- `skills/loop-engineering/SKILL.md` — tdd フェーズの実装部品（ミクロ層）
- `docs/adr/007-autonomous-loop-execution.md` / `docs/adr/008-orchestration-declarative-flow.md` — 設計決定
- `docs/adr/015-vibing-mode.md` — `--vibing` フラグと kind 降格（`resolve_kind`）の決定
- `docs/adr/018-remote-ci-as-done-condition.md` — remote CI green を pr の機械 success_test 成分とする決定
