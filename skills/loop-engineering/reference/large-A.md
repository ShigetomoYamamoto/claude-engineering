# 大規模A(A-大)のオーケストレーション

`loop-engineering` スキルの STEP0 で **A-大**(多ファイル/移行/仕様が重く「1 コンテキストに載らない」規模)と判定したときだけ読む詳細。中小規模の A は従来どおりメイン会話でインライン(STEP1〜6)で十分——分離はハンドオフで意図(なぜこの述語か・暗黙の前提)が欠落し往復が増えるので、**規模が要求しない限りやらない(過剰オーケストレーション禁止)**。

## 構造(計画→人間ゲート→実装→レビュー→判定)

```
A-中小(1〜数ファイル):従来のインライン STEP 1〜6(計画も実装も同一コンテキスト)
A-大(多ファイル/移行/重い仕様):
  ① Plan エージェント(PMロール・読取専用)が VISION+テスト設計を起草
  ② メインが内容をレビュー → 【人間ブロッキング承認ゲート】で利用者に見せて止まる
  ③ 承認した[機械]条件の赤テストを書き「赤」を目視(=ハンドオフの前提条件)
  ④ fixer が赤→緑の最小実装(workflow `loop-engineering-large-A` の execute)
  ⑤ /review-loop に委譲(STEP 5 のまま。レビュー往復は workflow に入れない)
  ⑥ STEP 6 で verify 再実行 + VISION 全[機械]条件を ID 照合して完了判定
```

## 規模に関わらず全 A で守る 3 つのガード

1. **`[機械]`条件について、赤テストが書けることがハンドオフの前提**。赤が書けない=VISION が曖昧 → **分離せず会話内で直す**(`loop-engineering-large-A` の execute は `[機械]`条件の赤を確認できないと `precondition_failed` で止まる。`[AI]`条件は赤テスト対象外)。
2. **承認ゲートは「VISION 述語に載らない口頭前提・暗黙の微決定」を人間が注入する場**。ここで拾えなかった穴はガード 3 で拾う。
3. **戻りチャネル(★最重要)**。実装中に VISION の穴が判明したら、fixer は**推測で埋めず**ループを抜けて承認ゲートへ戻り VISION を補修する。**同一コンテキストでも独断で VISION を解釈・補修しない**(workflow は `needs_vision_revision` で停止し人間に返す)。

## workflow `loop-engineering-large-A` の起動(契約は workflow が単一の正)

- 実体は `~/.claude/workflows/loop-engineering-large-A.js`(Workflow ツール)。**2回に分けて**起動: `{mode:"plan", goal, scope}` → 人間承認ゲート(会話側)→ `{mode:"execute", vision:<承認版>, scope, verifyCmd}`。
- **引数・返り値 `status`・各 status の捌き方は、workflow 本体の `meta.whenToUse` と返り値メッセージ(`reason` / `nextStep`)が単一の正。ここに再掲しない**(同じ契約を2か所に持たない=ドリフト防止。ADR-014)。返ってきた `status` と `nextStep` をそのまま読んで従う。
- workflow に書けない「会話側の責務」だけ押さえる:
  - **人間ゲートは会話側**(Workflow は途中で人間に聞けない)。plan→execute の間に承認を挟み、承認なしに execute しない。
  - **レビュー往復は workflow に入れない** → `/review-loop` に委譲(STEP5 のまま)。
  - **戻りチャネル**: `needs_vision_revision` が返ったら推測で埋めず、承認ゲートで VISION を補修してから再 execute。同じ穴で2回続けて止まったら利用者に相談。
- ⚠️ サブエージェントを多数起動しトークンを使う。**A-大と判断したときだけ**。`verifyCmd` は編集なしで実行できること。
