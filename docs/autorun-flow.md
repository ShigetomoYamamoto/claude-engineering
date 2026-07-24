# Autorun Flow — Declarative Flow Definition (the autonomous transition table)

> 置き場所: 本定義は [ADR-022](./adr/022-autorun-flow-out-of-always-loaded-rules.md) により `rules/`（常時ロード）から `docs/`（オンデマンド参照）へ移動した。ランタイム参照パスは `~/.claude/docs/autorun-flow.md`（install.py が docs/ を symlink）。内容・正本性は不変。

The single source of truth for the *shape* of the full pipeline, read by the
`/autorun` interpreter. It holds no execution logic — only **which phases run, in
what order, and where to stop**. Each phase's body is handled by existing commands /
agents / skills (parts are reused). The safety norm of record is `rules/loop-safety.md`.

## Modes (two modes = a difference of start/goal parameters)

| Mode | start | first phase | goal |
|------|-------|-------------|------|
| full-auto | a free-form objective | requirements | deploy |
| support | a concrete task / Issue | analyze-task | pr |

The two modes are not separate engines — the same transition table is given
different start/goal parameters.

**`--vibing` is an orthogonal flag, not a third mode.** It rides on *either*
full-auto or support and only changes how `kind` is resolved (see "vibing demotion
rules" below). It adds `vibing` / `design_needed` / `isolation` to RUN_STATE and
leaves this transition table untouched. Without the flag, behaviour is exactly as
defined here (ADR-015).

## Phase transition table

| phase_id | execution part | kind | success_test (decided mechanically) | full-auto next | support next |
|----------|----------------|------|-------------------------------------|----------------|-------------|
| requirements | requirements-analyst | **gate** | human approves the requirements | design | — |
| analyze-task | task-analyst | auto | breakdown + acceptance criteria produced | plan | plan |
| design | architect | **gate** (skippable) | human approves the design | plan | plan |
| plan | planner | auto | the plan has file paths and ordered steps | tdd | tdd |
| tdd | `skills/loop-engineering/` (delegated to the micro layer) | auto | tests/lint/typecheck pass and coverage 80%+ (measured via Bash) | verify | verify |
| verify | `/review-loop` (delegated) | auto | reviewer returns NO_ISSUES and mechanical checks pass | commit | commit |
| commit | `/commit-commands:commit` | auto (※) | code-reviewer CRITICAL/HIGH=0 and secret-detection passes | pr | pr |
| pr | `/create-pr` | **gate** | remote CI green（機械・CI 実在時）＋ human approves the PR（push/PR via gh） | migrate | (goal) |
| migrate | `/migrate` | auto (destructive changes confirmed) | migration succeeds | deploy | — |
| deploy | `/deploy` | **gate** | human approves the deploy | (goal) | — |

※ commit is kind=auto only because `/autorun` obtained a one-time blanket approval
for auto-commits at startup (`rules/git-workflow.md` autonomous-run exception). The
message is shown in the transcript every time. Without that approval, treat commit as a gate.

## Remote CI green は pr の機械 success_test 成分（ローカル green では done としない）

`pr` の success_test は2成分: **(機械) remote CI green** ＋ **(人間/無印) PR 承認**。ローカルの
test/lint/typecheck green は必要条件だが十分ではない — チームが正とする remote CI（GitHub Actions 等）が
green になって初めて done。PR push が CI を起動するので順序は「PR 作成 → CI 起動 → green 待ち（`gh run watch
<run-id> --exit-status`）→ 前進/merge」。**赤 / タイムアウト / run 検出不能は STOP（fail-safe=停止）**。CI が
実在しないプロジェクトは待つものが無いので skip するが、その旨を transcript にログする（起動時チェックで検出）。
この機械成分は不変条件1（machine-checked done-condition, ADR-014）であり、**vibing でも降格しない**
（vibing が外すのは PR 承認の*事前確認*＝人間ゲート成分だけ、後述 resolve_kind）。CI 待ちは「手続き＋機械チェック」
で担保し**物理層（hook）は無い**（hooks は Bash 経由 git/PR のみ・過大表示しない、ADR-018）。

## Gates (kind=gate, the human always confirms)

- **requirements** — direction that cannot be judged mechanically (are the requirements right?). Largest rework cost.
- **design** — same (architecture decisions). May be skipped if the skip condition below holds.
- **pr** — outward-facing, irreversible (`git push`).
- **deploy** — irreversible production change.

The norm for irreversible stop points (pr / deploy / migrate destructive changes) is `rules/loop-safety.md`.

## vibing demotion rules (`resolve_kind`, applies only when `--vibing` is on)

The transition table's `kind` column stays at its base value. When `--vibing` is on,
insert one step *before* the kind branch (autorun.md step 4-5): apply
`resolve_kind(phase, state)`, which demotes machine-verifiable + reversible gates to
`auto`. This is the only injection point — the engine is otherwise unchanged. This
keeps a single source of truth: `kind` base lives in the table, the vibing transform
lives here, never duplicated (ADR-014). Without the flag, `resolve_kind` returns the
base `kind` unchanged (so the four gates stand — full backward compatibility).

`resolve_kind` derivation (this is the authoritative definition):

| phase | kind_base | vibing-resolved | predicate |
|-------|-----------|-----------------|-----------|
| requirements | gate | **gate (kept)** | the one upfront direction check — NOT demoted |
| analyze-task | auto | auto | — |
| design | gate (skippable) | `design_needed ? gate : auto` | gate only when new DB schema / new API / tech selection / system-boundary change is needed |
| plan / tdd / verify | auto | auto | — |
| commit | auto | auto | — |
| pr | gate | **auto (→ main direct)** | demoted; main PR allowed via the `pr-base-checker.py` vibing marker (B-1) |
| deploy | gate | `deploy_irreversible ? gate : auto` | auto only if auto-rollback exists; else gate |
| migrate | auto / gate | `migrate_destructive ? gate : auto` | DROP/RENAME/TRUNCATE etc. → gate |
| (external send) | — | gate | unrecoverable → kept |

So vibing actually drops only two pre-confirmations: **PR push** and **reversible
deploy**. requirements/design remain direction gates; unrecoverable ops stay gates.

**ただし pr の降格対象は PR 承認の*事前確認*（人間ゲート成分）のみ。** pr success_test のもう一方の成分である
**remote CI green（機械成分）は不変条件1であり vibing でも降格しない** — vibing は事前確認を外すモードであって
機械検証を外すモードではない（ADR-015 の不変条件1不可侵、ADR-018）。よって vibing でも pr→auto は remote CI
green を機械確認してからでないと前進・merge しない。

**Predicates for the kept stop points (single point of failure — fail-safe = gate):**

- `migrate_destructive(dry_run_sql)` — true if the dry-run SQL contains DROP TABLE/COLUMN,
  TRUNCATE, RENAME (TABLE|COLUMN), `ALTER ... DROP`, or `DELETE` without `WHERE`. If the
  dry-run cannot be obtained or parsed → **true (gate)**.
- `deploy_irreversible(target)` — true if deploy-runner cannot detect an auto-rollback
  mechanism (vercel rollback / fly releases rollback / kubectl rollout undo, etc.). If
  undetectable → **true (gate)**.
- `external_send(actions)` — true if the phase would send outward (slack/webhook/email/
  external API POST). If detected → **gate**.

Every `resolve_kind` evaluation is printed to the transcript ("this migrate is
non-destructive → auto-connect"), so a human can audit after the fact. **These three
gates have no physical layer** (hooks only fire on Bash-routed git/PR — not on
migrate/deploy/external send). They are gate + procedure only; do not overstate.

## design skip decision (input = the requirements phase output)

When design is reached, plan has not run yet, so judge from the **requirements
output**. Have requirements-analyst emit a "needs new DB schema / new API / tech
selection / system-boundary change?" flag; if all are unnecessary, skip the design
gate and auto-advance to plan (don't stop or skip by mistake).

Vibing reuses this exact flag — `resolve_kind` reads the same `design_needed` to decide
whether design stays a gate. Vibing introduces no new design-skip criterion.

## Scope handoff to the tdd phase (single judge)

`/autorun` has already decided scope by the time it reaches `tdd` (requirements /
analyze-task + plan produced file paths and ordered steps). When it delegates the tdd
phase to `skills/loop-engineering/`, it passes that scope down in the preamble; the
skill **adopts it and does NOT re-run its own STEP0 (A/B/C) sizing**. The A/B/C
judgment is the skill's behavior only in standalone use (no RUN_STATE). This keeps a
single judge of scope (see `rules/loop-safety.md` "Single entry, single judge" / ADR-014).

## Requirement → VISION handoff (closing the loop top-to-bottom)

The done-condition of the code rung (loop-engineering's VISION) is not invented from
scratch under `/autorun`. The **acceptance criteria** produced at the requirements rung
(`requirements-analyst`) or analyze-task rung (`task-analyst`) — which those agents must
make *testable* — flow down through `plan` and become the **seed of the VISION predicates**
at the tdd phase (one acceptance criterion → one machine-checkable VISION predicate, carried
with a stable ID). This keeps the loop closed top-to-bottom: the thing the human approved at
the gate is the same thing the machine checks at the bottom. loop-engineering adopts these
rather than re-eliciting them (see `skills/loop-engineering/SKILL.md` STEP2; ADR-014).

Besides the in-context seed, the **approved requirements are persisted to `docs/requirements.md`**
(the orchestrator delegates the write to `executor`; requirements-analyst has no Write tool) so a
full-auto run on a fresh project still leaves a durable requirements-of-record, not only an
in-context artifact. See `agents/requirements-analyst.md` "Persist on Approval".

The same durability applies downstream: the **approved design is persisted to `docs/design.md`**
once the design gate clears (`agents/architect.md` "Persist on Approval"), and the **finalized
plan is persisted to `docs/plan.md`** as soon as it's produced — `plan` is `auto`, not a gate
(above), so this persists on finalization rather than on approval (`agents/planner.md` "Persist
the Plan"). Same write-delegation pattern as requirements: the orchestrator writes directly as
the Sonnet main loop, or delegates to `executor` only while escalated.

## Mechanical verifiability check (at startup)

At `/autorun` startup, detect via Bash whether every auto phase's success_test is
mechanically verifiable in this project (existence of test / lint / typecheck
commands). If any is undetectable, stop early with "cannot self-run — reporting
what's missing" (avoid stalling mid-run).

Also detect whether the project has **remote CI** (a `.github/workflows/*.yml` triggered on
pull_request / push). If present, `remote CI green` is required as the machine component of
the `pr` success_test (above). If absent, there is nothing to wait for — skip the CI wait but
**log "CI 未検出のため CI green チェックなし" to the transcript** so the omission is visible, never silent
(ADR-018).

## Whitelist of places it may stop

An autonomous run may stop ONLY at:

1. The four gates (requirements / design / pr / deploy)
2. A hard stop (below, two-layer)
3. A per-phase retry cap
4. Goal reached (full-auto=deploy / support=pr)
5. Startup precondition / verifiability failure (early stop)
6. Irreversible-op confirmation (migrate DROP/RENAME etc., all irreversible ops defined in `rules/loop-safety.md`)
7. Unrecoverable error (e.g. build-error-resolver hitting its cap)
8. Remote CI red / CI not yet completed at the `pr` advance point or a shared-branch (develop/main) merge point — the machine success_test (remote CI green) is unmet; merging red CI into a shared branch pollutes state others depend on (fail-safe = stop). See ADR-018.

Stopping anywhere else is a definition violation — detect and report it.

Under `--vibing` the whitelist's item 1 shrinks: the only gates that remain are
**requirements, design (when `design_needed`), and the unrecoverable-op gates**
(external send / destructive migrate / rollback-incapable deploy, per "vibing demotion
rules"). pr and reversible deploy no longer stop. Items 2–8 are unchanged — in particular
**item 8 (remote CI red/incomplete) is NOT removed by vibing**: it is a machine success_test
(invariant 1), not a pre-confirmation gate (ADR-018).

## Rollback is manual-only (intentionally not a phase)

There is no `rollback` row in the table on purpose. Autonomous runs perform only
*auto*-rollback, which lives inside `deploy-runner` on verification failure (part of the
`deploy` phase). *Manual* rollback (`rollback-runner` / `/rollback`) is human-initiated and
therefore deliberately outside this flow and its stop-whitelist — not a missing phase.

## Hard stop (two-layer)

- **Per-phase budget**: verify=5 rounds, tdd=the micro layer (loop-engineering) internal cap. Per-phase default.
- **Whole-run budget**: a total transition-count cap + the session ceiling in `rules/loop-safety.md` (default 20 turns / 30 min). The per-phase and whole-run budgets are independent; whichever is hit first stops the run.
- **vibing transition cap**: because vibing connects to the goal without human gate waits, only the *transition-count* cap is raised — full-auto=24 / support=14. The session ceiling (20 turns / 30 min) and per-phase budgets are **unchanged**. In practice the time ceiling often fires before the transition cap — that is invariant 3 (bounded) working, not a removed limit (ADR-015).

## Single-command use (RUN_STATE not declared)

When a command is invoked directly (`/requirements` etc.), this flow definition does
not apply and each command falls back to its **conventional guided stop**. The kind
values here take effect only in an autonomous run (where RUN_STATE is declared).

## Related

- `commands/autorun.md` — the interpreter that reads this definition
- `rules/loop-safety.md` — the safety norm of record (hard stop / goal drift / irreversible ops)
- `docs/adr/007-autonomous-loop-execution.md` — the four-gate decision
- `docs/adr/008-orchestration-declarative-flow.md` — the declarative-flow decision and commit blanket approval
- `docs/adr/015-vibing-mode.md` — the `--vibing` flag and the gate-demotion (`resolve_kind`) decision
- `docs/adr/018-remote-ci-as-done-condition.md` — remote CI green as the machine success_test component of `pr` (invariant 1; not demoted by vibing)
- `skills/loop-engineering/SKILL.md` — the tdd phase's execution part (micro layer)
