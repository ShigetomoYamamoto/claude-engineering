export const meta = {
  name: 'loop-engineering-large-A',
  description:
    '大規模フルA向け orchestration。mode:"plan" は読取専用 Plan を fan-out して VISION 条件を起草し抜け漏れを批評する。mode:"execute" は 赤確認(RedGate)→モジュール毎の最小実装(逐次)→verify を回す。レビュー往復は含めず /review-loop に委譲する。',
  whenToUse:
    'loop-engineering のフルA のうち、多ファイル/移行/仕様が重く 1 コンテキストに載らない規模のときだけ。まず {mode:"plan", goal, scope} で VISION 草案を得て人間が承認し赤テストを書く → {mode:"execute", vision:<承認版>, scope, verifyCmd} で実装〜検証。scope は配列(例 ["src/foo.ts"])。カンマ区切り文字列も配列化して受理する。中小規模はこの workflow を使わずメイン会話でインライン(skill STEP1〜6)。',
  phases: [
    { title: 'Plan', detail: 'Plan エージェントを fan-out して VISION 条件を起草し完全性を批評' },
    { title: 'RedGate', detail: '各[機械]条件のテストが赤であることを確認(赤が無ければ中止)' },
    { title: 'Implement', detail: 'モジュール毎に fixer が最小実装で赤→緑(VISIONの穴は戻りチャネルで停止)' },
    { title: 'Verify', detail: 'verifyCmd を実行し exit と VISION[機械]条件の緑を ID 照合' },
  ],
}

// ---------- schemas ----------
const CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'N/E/B/S/Q + 連番。例 N1, E2, B1' },
    tag: { type: 'string', enum: ['機械', 'AI'], description: '検証手段。迷ったら機械に寄せる' },
    axis: { type: 'string', enum: ['N', 'E', 'B', 'S', 'Q'] },
    predicate: { type: 'string', description: '「○○すると△△になる」の観測可能な述語' },
    testFile: { type: 'string', description: '対応テストファイルの候補パス' },
    testIdea: { type: 'string', description: 'どう assert するか' },
    module: { type: 'string', description: '任意。条件が属するモジュール/ファイル群' },
  },
  required: ['id', 'tag', 'axis', 'predicate'],
}
const VISION_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    conditions: { type: 'array', items: CONDITION_SCHEMA },
    notes: { type: 'string' },
  },
  required: ['conditions'],
}
const RED_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    allRed: { type: 'boolean', description: '全[機械]条件のテストが赤なら true' },
    perCondition: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['red', 'green', 'missing'] },
          detail: { type: 'string' },
        },
        required: ['id', 'state'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['allRed', 'perCondition'],
}
const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    module: { type: 'string' },
    status: { type: 'string', enum: ['done', 'needs_vision_revision', 'blocked'] },
    changedFiles: { type: 'array', items: { type: 'string' } },
    conditionsTurnedGreen: { type: 'array', items: { type: 'string' } },
    conditionId: { type: 'string', description: 'needs_vision_revision/blocked のとき、穴/障害が判明した条件 ID' },
    visionHole: { type: 'string', description: 'needs_vision_revision のとき、VISION のどこに穴/曖昧/矛盾があるか' },
    notes: { type: 'string' },
  },
  required: ['module', 'status', 'changedFiles'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verifyExit: { type: 'integer', description: 'verifyCmd の exit code' },
    perCondition: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          green: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['id', 'green'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verifyExit', 'perCondition'],
}

// ---------- args ----------
// この環境では args が「パース済みオブジェクト」ではなく「JSON 文字列」でスクリプトに届くことがある
// (実測: typeof args === 'string')。オブジェクト/文字列のどちらで来ても動くよう冒頭で正規化する。
let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try {
    parsedArgs = JSON.parse(parsedArgs)
  } catch (e) {
    return { status: 'bad_args', message: 'args を JSON として解釈できませんでした。{mode:"plan"|"execute", ...} を渡してください。' }
  }
}
if (!parsedArgs || typeof parsedArgs !== 'object') {
  return { status: 'bad_args', message: 'args が空です。{mode:"plan"|"execute", goal, scope, ...} を渡してください。' }
}
const mode = parsedArgs.mode
// scope は配列前提(plan の fan-out, execute の Set/filter/map/join が配列を要求する)。
// 文字列(カンマ区切り)で来ても配列化する。配列/文字列/未指定 以外の型は弾く。mode 分岐より前なので plan/execute 両方を守れる。
let scope
if (Array.isArray(parsedArgs.scope)) {
  scope = parsedArgs.scope.map((s) => String(s).trim()).filter(Boolean)
} else if (typeof parsedArgs.scope === 'string') {
  scope = parsedArgs.scope.split(',').map((s) => s.trim()).filter(Boolean)
} else if (parsedArgs.scope == null) {
  scope = []
} else {
  return { status: 'bad_args', message: 'scope は配列(例 ["src/foo.ts"])かカンマ区切り文字列で渡してください。' }
}
const focus = parsedArgs.focus || '(なし=reviewer デフォルト観点)'
const goal = parsedArgs.goal || ''
const verifyCmd = parsedArgs.verifyCmd || 'npm run verify'
const vision = parsedArgs.vision || null

if (mode !== 'plan' && mode !== 'execute') {
  return {
    status: 'bad_args',
    message:
      'args.mode に "plan" か "execute" を指定してください。plan: {mode:"plan", goal, scope, focus?}。execute: {mode:"execute", vision:<承認版>, scope, verifyCmd?, focus?}。',
  }
}

const dedupKey = (c) => (c && c.predicate ? String(c.predicate).replace(/\s/g, '').slice(0, 60) : '')

// axis ごとに通し番号を振り直して ID を全体で一意化する。
// (fan-out の各エージェントが独立に 1 から採番するため N1/E1… が乱立する ID 衝突を、LLM 任せにせず決定的に解消)
const AXIS_ORDER = ['N', 'E', 'B', 'S', 'Q']
function renumber(conds) {
  const out = []
  for (const ax of AXIS_ORDER) {
    let n = 0
    for (const c of conds) {
      const cax = AXIS_ORDER.includes(c.axis) ? c.axis : 'Q' // 不明な axis は Q(曖昧品質)に寄せる
      if (cax === ax) {
        n++
        out.push({ ...c, axis: cax, id: `${ax}${n}` })
      }
    }
  }
  return out
}

// ===================== PLAN MODE =====================
// 計画専任の読取専用 Plan を fan-out して VISION 草案を作り、人間の承認ゲートに返す。実装はしない。
if (mode === 'plan') {
  phase('Plan')
  const chunks = scope.length ? scope : [goal || '(対象未指定)']
  log(`計画モード: ${chunks.length} 単位を Plan で起草 / goal="${goal}"`)

  const drafts = await parallel(
    chunks.map((c, i) => () =>
      agent(
        `あなたは loop-engineering の PM ロール(計画専任・読取専用・実装禁止)。\n` +
          `ゴール: ${goal}\n担当範囲: ${typeof c === 'string' ? c : JSON.stringify(c)}\n重点(FOCUS): ${focus}\n\n` +
          `★自分の担当範囲に直接関係する合格条件だけを「○○すると△△になる」の観測可能な述語で列挙せよ` +
          `(他範囲と汎用的に被るだけの条件は出さない)。\n` +
          `各条件に必ず axis(N正常/E異常・エラー処理/B境界/S状態/Q曖昧品質)・検証手段タグ(機械/AI)・` +
          `predicate・module(担当範囲)・対応テストファイル候補・テスト方針 を付ける。\n` +
          `★predicate は「非エンジニアが読んで何のことか分かる言葉」で書く: 利用者が画面で見る/操作する内容を「○○すると△△になる」で表す。\n` +
          `  - プロジェクト固有の名前(store/状態管理/関数名/内部変数/origin=user のような内部値)は predicate に入れない → それらは「テスト方針」側に書いて保持する(情報は捨てない)。\n` +
          `  - textarea・クリック・フォーカス・blur・Enter キーなど、どのアプリでも通じる汎用UI用語は使ってよい。\n` +
          `ID は仮で構わない(後でオーケストレータが全体で振り直す)。\n` +
          `「使いやすく」「ちゃんと」のような測れない述語は禁止。迷ったら必ず[機械]に寄せる。コードは書くな。`,
        {
          label: `plan:${typeof c === 'string' ? c.slice(0, 24) : i}`,
          phase: 'Plan',
          agentType: 'Plan',
          schema: VISION_DRAFT_SCHEMA,
        }
      )
    )
  )

  // 全 fan-out 結果をマージ(述語の完全一致だけ軽く除去。意味的重複と ID 衝突は後段の統合で処理する)
  const rawConds = []
  const seen = new Set()
  for (const d of drafts.filter(Boolean)) {
    for (const c of d.conditions || []) {
      const k = dedupKey(c)
      if (k && seen.has(k)) continue
      if (k) seen.add(k)
      rawConds.push(c)
    }
  }
  const rawCount = rawConds.length

  // 統合 + 抜け補完(★これが「オーケストレータの手作業」を肩代わりする中核):
  // N 人が独立起草したため、ID 衝突(N1/E1 が乱立)と意味的重複(言い回し違いの同一条件)が残る。
  // これを 1 人のエージェントに一貫統合させる。入力は必須フィールドだけに絞ってトークンを抑える。
  const slim = rawConds.map((c) => ({ axis: c.axis, tag: c.tag, predicate: c.predicate, module: c.module }))
  const consolidated = await agent(
    `あなたは VISION 統合担当(読取専用・実装禁止)。${chunks.length} 人のエージェントが独立起草した合格条件 ${rawCount} 個を、1 つの一貫した VISION に統合せよ。\n` +
      `ゴール: ${goal}\n\n手順:\n` +
      `1) 意味的に重複/包含する条件は 1 つにまとめる(言い回し違いの同一条件、上位↔下位関係)。\n` +
      `2) 5軸(N正常/E異常/B境界/S状態/Eエラー処理)で抜けている条件を補う。\n` +
      `3) 各条件に axis(N/E/B/S/Q)・tag(機械/AI)・predicate(○○すると△△)・module・対応テストファイル候補・テスト方針 を付ける。\n` +
      `4) [機械]にできるものは[機械]に寄せる。○×の付かない曖昧述語は具体化する。\n` +
      `5) ★predicate は非エンジニアが読んで分かる言葉にする: 利用者が画面で見る/操作する内容で書く。\n` +
      `   - 入力の述語に含まれる内部メカニズム(store/状態管理/関数名/内部変数/origin=user 等の内部値)は predicate から外し、「テスト方針」(testIdea)に移して保持せよ(情報は捨てない)。\n` +
      `   - textarea・クリック・フォーカス・blur・Enter 等、どのアプリでも通じる汎用UI用語は predicate に残してよい。\n` +
      `※ ID は付けなくてよい(オーケストレータが axis ごとに振り直す)。\n\n` +
      `入力条件(${rawCount}個):\n${JSON.stringify(slim, null, 2)}\n\n` +
      `統合後の最終条件リストを conditions に返せ。`,
    { label: 'plan:consolidate', phase: 'Plan', agentType: 'Plan', schema: VISION_DRAFT_SCHEMA }
  )
  // 統合が失敗(null/空)したら raw にフォールバックしてでも、ID だけは決定的に振り直して一意化する
  const finalConds = renumber((consolidated && consolidated.conditions && consolidated.conditions.length)
    ? consolidated.conditions
    : rawConds)

  return {
    mode: 'plan',
    status: 'plan_ready',
    goal,
    scope,
    focus,
    visionDraft: { conditions: finalConds },
    rawCount, // fan-out 直後の生条件数(統合前)
    consolidatedCount: finalConds.length, // 統合 + ID 振り直し後の数
    machineCount: finalConds.filter((c) => c.tag === '機械').length,
    aiCount: finalConds.filter((c) => c.tag === 'AI').length,
    nextStep:
      'この VISION 草案(意味的重複を統合済み・ID は axis ごとに一意化済み)を利用者に見せて承認を得る(=人間ブロッキング承認ゲート)。' +
      '承認時に、述語に載っていない口頭前提・暗黙の微決定があれば注入して条件を補強する。' +
      '承認後、各[機械]条件の赤テストを書いて「赤」を目視してから {mode:"execute", vision:<承認版>, scope, verifyCmd} で再実行する。' +
      '赤が書けない条件は VISION が曖昧 → 分離せず会話内で直す。',
  }
}

// ===================== EXECUTE MODE =====================
// 前提: vision は人間が承認済み。各[機械]条件の赤テストは会話側で作成・赤を目視済み。
if (!vision || !Array.isArray(vision.conditions) || vision.conditions.length === 0) {
  return {
    status: 'bad_args',
    message:
      'execute モードには承認済み args.vision.conditions(非空配列)が必要です(plan モードの出力を人間が承認したもの)。',
  }
}
// VISION 構造の整合性を入口で検証(人間の承認時に壊れていないか。壊れていれば後段の静かな取りこぼし/穴の誤認になる)
const seenIds = new Set()
for (const c of vision.conditions) {
  if (!c || typeof c.id !== 'string' || c.id.trim() === '') {
    return { status: 'bad_args', message: '空または無効な id を持つ条件があります。全条件に「N/E/B/S/Q+連番」の ID が必要です。' }
  }
  if (typeof c.predicate !== 'string' || c.predicate.trim() === '') {
    return { status: 'bad_args', message: `ID ${c.id} の predicate が空です。「○○すると△△になる」の述語が必須です。` }
  }
  if (seenIds.has(c.id)) {
    return { status: 'bad_args', message: `ID が重複しています: ${c.id}。各条件の ID は一意にしてください。` }
  }
  seenIds.add(c.id)
}
const machineConds = vision.conditions.filter((c) => c.tag === '機械')
if (machineConds.length === 0) {
  return { status: 'bad_args', message: '承認 VISION に[機械]条件が 1 つもありません。execute できません。' }
}
// module タグは「全[機械]条件に付ける」か「全く付けない」の二択に統一(混在は条件の静かな取りこぼしを生む)
const someTagged = machineConds.some((c) => c.module)
const allTagged = machineConds.every((c) => c.module)
if (someTagged && !allTagged) {
  return {
    status: 'bad_args',
    message:
      'module タグが一部の[機械]条件にしか付いていません。全条件に付ける(モジュール分割)か、全く付けない(一括)かに統一してください。',
  }
}
// module タグ付きなら scope 必須 + scope と module の双方向被覆を検証(scope にあるのに条件が無い/条件にあるのに scope に無い を弾く)
if (allTagged) {
  if (!scope.length) {
    return { status: 'bad_args', message: 'module タグ付き VISION には scope(対象モジュール一覧)が必須です。' }
  }
  const condModules = new Set(machineConds.map((c) => c.module))
  const scopeSet = new Set(scope)
  const scopeWithoutConditions = scope.filter((m) => !condModules.has(m))
  const conditionsModulesNotInScope = [...condModules].filter((m) => !scopeSet.has(m))
  if (scopeWithoutConditions.length || conditionsModulesNotInScope.length) {
    return {
      status: 'scope_mismatch',
      message: 'scope と VISION の module が一致しません(静かな取りこぼし防止のため中止)。',
      scopeWithoutConditions,
      conditionsModulesNotInScope,
    }
  }
}

// --- RedGate: ハンドオフ前提の構造的担保(赤が確認できなければ実装に入らない) ---
phase('RedGate')
const redCheck = await agent(
  `あなたは検証担当(読取専用・編集禁止)。次の[機械]条件それぞれに対応するテストを実行し、現在「赤(失敗)」か確認せよ。\n` +
    `検証コマンド: ${verifyCmd}(個別テストは各条件の testFile を使ってよい)\n` +
    `条件:\n${JSON.stringify(machineConds, null, 2)}\n\n` +
    `各条件の state を red(期待どおり失敗)/green(既に通っている=偽パス疑い)/missing(テストが無い)で報告せよ。実装・編集はするな。`,
  { label: 'redgate', phase: 'RedGate', agentType: 'Explore', schema: RED_CHECK_SCHEMA }
)
if (!redCheck || !redCheck.allRed) {
  const bad = ((redCheck && redCheck.perCondition) || []).filter((p) => p.state !== 'red')
  const missingTests = bad.filter((p) => p.state === 'missing').map((p) => p.id)
  const falsePositives = bad.filter((p) => p.state === 'green').map((p) => p.id)
  return {
    mode: 'execute',
    status: 'precondition_failed',
    reason:
      `赤テスト前提が未達(ハンドオフ禁止)。テスト未作成 ${missingTests.length} 件(新規にテストを書く)、` +
      `偽パス=既に緑 ${falsePositives.length} 件(テストを書き直して赤を出す)。会話側で対処し「赤」を目視してから再実行せよ。`,
    missingTests,
    falsePositives,
    badConditions: bad,
    redCheck,
  }
}

// --- Implement: 実装単位ごとに逐次(同一作業ツリーへの並列編集による衝突を避けるため parallel/worktree は使わない) ---
// 実装単位 = module タグ付きなら「モジュール毎」、未タグなら「scope 全体を 1 単位」。
//            未タグで複数 scope を各モジュールに回すと全条件が二重実装されるため、1 単位にまとめる。
phase('Implement')
const units = allTagged
  ? scope.map((m) => ({ label: String(m), target: String(m), conds: machineConds.filter((c) => c.module === m) }))
  : [{ label: '(全体)', target: scope.length ? scope.join(', ') : '(全体)', conds: machineConds }]
const implResults = []
for (let i = 0; i < units.length; i++) {
  const u = units[i]
  if (!u.conds.length) continue // 被覆検証済みなので通常は起きない(防御)
  const r = await agent(
    `あなたは実装担当(fixer / maker)。承認済み VISION の[機械]条件を「赤→緑」にする最小実装を書け。\n` +
      `対象: ${u.target}\nFOCUS: ${focus}\n` +
      `担当条件:\n${JSON.stringify(u.conds, null, 2)}\n\n` +
      `ルール:\n` +
      `- 担当条件だけ実装する。変更は最小限。レッド→グリーン。\n` +
      `- テストは消さない・条件は削らない・緑にするための嘘実装(固定値返し等)をしない。\n` +
      `- ★戻りチャネル: 実装中に「VISION の述語自体が曖昧/矛盾/穴がある」と判明したら、推測で埋めず ` +
      `status="needs_vision_revision"、conditionId に対象条件 ID、visionHole に理由を入れて即座に返す(独断で VISION を解釈・補修しない)。\n` +
      `- スコープ外のファイルは触らない。完了したら status="done"、changedFiles、conditionsTurnedGreen を返す。`,
    {
      label: `impl:${u.label.slice(0, 24)}`,
      phase: 'Implement',
      agentType: 'fixer',
      schema: IMPLEMENT_SCHEMA,
    }
  )
  implResults.push(r)
  if (!r) {
    // 実装担当が null(エージェント失敗/スキュー)。他フェーズ(RedGate/Verify)と同様に明示停止。
    // これを握り潰すと未実装のまま Verify に進み verify_failed に化け、誤った復旧手順に誘導される。
    return {
      mode: 'execute',
      status: 'impl_error',
      reason:
        '実装担当(fixer)が結果を返しませんでした(エージェント失敗/スキュー)。当該ユニットを再実行せよ。' +
        'verify_failed とは別物(実装が走っていない)。',
      module: u.label,
      doneSoFar: implResults.filter(Boolean),
    }
  }
  if (r && r.status === 'needs_vision_revision') {
    // 戻りチャネル: 人間の承認ゲートに戻す。これ以上実装しない。
    return {
      mode: 'execute',
      status: 'needs_vision_revision',
      reason:
        '実装中に VISION の穴が判明(戻りチャネル)。fixer は推測で埋めず停止した。visionHole を確認し承認ゲートに戻って VISION を補修してから再実行せよ。',
      conditionId: r.conditionId,
      module: r.module,
      visionHole: r.visionHole,
      doneSoFar: implResults.filter(Boolean),
    }
  }
  if (r && r.status === 'blocked') {
    return {
      mode: 'execute',
      status: 'blocked',
      reason: '実装担当が blocked を返した。原因を確認して会話側で対処せよ。',
      conditionId: r.conditionId,
      module: r.module,
      notes: r.notes,
      doneSoFar: implResults.filter(Boolean),
    }
  }
}

// --- Verify: 機械的ゲート + 条件 ID 照合 ---
phase('Verify')
const verify = await agent(
  `あなたは検証担当(読取専用・編集禁止)。次を実行して報告せよ。\n` +
    `1) ${verifyCmd} を実行し exit code を verifyExit に入れる。\n` +
    `2) 承認済み[機械]条件それぞれのテストが今「緑」かを perCondition に入れる(id で照合)。\n` +
    `条件:\n${JSON.stringify(machineConds, null, 2)}\n実装・編集はするな。`,
  { label: 'verify', phase: 'Verify', agentType: 'Explore', schema: VERIFY_SCHEMA }
)
const changedFiles = [
  ...new Set(implResults.filter(Boolean).flatMap((r) => r.changedFiles || [])),
]
// 検証担当の失敗(verifyExit を返せない等)を「実装失敗」と取り違えないよう区別する
if (!verify || typeof verify.verifyExit !== 'number') {
  return {
    mode: 'execute',
    status: 'verify_error',
    reason:
      'verify 担当が verifyExit を返せませんでした(エージェント失敗/スキュー)。実装の問題とは限らない。verify フェーズを再実行せよ(実装は doneSoFar で完了済み)。',
    changedFiles,
    doneSoFar: implResults.filter(Boolean),
  }
}
const allGreen = verify.verifyExit === 0 && (verify.perCondition || []).every((p) => p.green)

return {
  mode: 'execute',
  status: allGreen ? 'green' : 'verify_failed',
  verifyExit: verify.verifyExit,
  conditions: verify.perCondition || [],
  changedFiles,
  nextStep: allGreen
    ? `execute 緑。次はメイン会話で /review-loop(SCOPE=変更ファイル, FOCUS=${focus})を NO_ISSUES まで回す。` +
      `その後 skill STEP6 で verify を再実行し、VISION 全[機械]条件の緑を ID 照合して完了判定。レビュー往復はこの workflow に入れない(委譲する)。`
    : 'verify が exit≠0 か未緑条件あり。skill STEP4 に戻って修正せよ。緑になるまでレビューには進まない。完了条件は緩めない(テスト削除・条件削減・嘘実装は禁止)。',
}
