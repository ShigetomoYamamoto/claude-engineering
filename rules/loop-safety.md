# Loop Safety — Autonomous Run Guardrails

Rules for running Claude in autonomous "loops" — self-paced `/loop`, `/goal`,
`ScheduleWakeup`, or `Workflow` — i.e. whenever Claude continues across turns
without a human prompt in between. A loop with no brakes is the failure mode,
not the exception.

## The four invariants (Loop Engineering constitution)

Per [ADR-014](../docs/adr/014-loop-engineering-as-discipline.md), every Loop
Engineering loop — at any scope (one code change, a review cycle, or a full
`/autorun` pipeline) — must uphold four invariants. The guardrails in this file
are how they are enforced in an autonomous run:

1. **Done-condition is upfront, machine-checked, un-fakeable** — see Preconditions 1 & 3.
2. **Maker ≠ checker** — whoever produces the work does not grade it — see Precondition 5.
3. **Bounded** — every run carries an explicit hard stop — see Hard stops.
4. **Human owns direction & irreversible** — see Irreversible / outward-facing actions.

Invariants 1 & 3 keep the loop *correct*; 2 & 4 keep it *safe*. A loop that breaks
any one of them is not Loop Engineering, however much machinery surrounds it.

**`/autorun --vibing` exception (the only carve-out, ADR-015):** vibing relaxes
invariant 4's *pre-confirmation* — and only for **reversible** irreversible/outward ops
(PR push, auto-rollback-capable deploy). Invariants **1, 2, and 3 stay inviolable**, and
the unrecoverable ops (external send, destructive migrate, rollback-incapable deploy)
keep their human gate. The relaxation is paid for with post-hoc audit + auto-rollback +
transcript record (mitigation, not a gate). Vibing is only safe *because* invariant 1
(the machine-checked done-condition) still closes top-to-bottom; if invariant 1 breaks,
vibing is no longer safe.

## Preconditions (ALL required before starting a loop)

Do NOT start an autonomous loop unless every one of these holds:

1. **Clear done-condition** — completion can be stated in one sentence and is machine-verifiable.
2. **Safe workspace** — work happens on a dedicated branch or git worktree, never on `main` / `master` / `develop`.
3. **Mechanical success test** — tests / lint / type-check / a script decides success, NOT the agent's self-assessment. **When the project has remote CI (e.g. GitHub Actions), local green is necessary but NOT sufficient — the done-condition includes remote CI green; never treat "local green" as merge-able on its own** (ADR-018).
4. **Hard stop** — at least one explicit limit (turns, wall-clock, or token budget) is set (see below).
5. **Separate checker** — success is judged by someone/something other than the maker:
   a test the maker wrote that runs independently, a reviewer agent (`/review-loop`),
   or a different model (`/review-loop-cross`). The implementer never signs off on its
   own work (invariant 2). This is distinct from #3: #3 says "machine, not self-assessment";
   #5 says "the grader is not the maker".

If success cannot be judged mechanically (business judgment, creative direction,
"make it nice"), DO NOT loop — keep a human in the decision.

## Hard stops (CRITICAL)

Every autonomous run MUST carry at least one explicit ceiling:

- **Turn cap** — e.g. `... or stop after 20 turns`
- **Wall-clock cap** — stop after N minutes
- **Token / cost budget** — stop when the run's budget is exhausted

When the user sets no limit, default to **20 turns OR 30 minutes, whichever comes
first**, then stop and report. Never silently continue past a ceiling.

## Goal drift

- Re-state the original done-condition at the start of each iteration. If the
  current work no longer maps to it, STOP and report instead of improvising a new goal.
- The completion evaluator only sees the conversation output — make every step's
  result observable in the transcript (run the check, show the result).

## Irreversible / outward-facing actions

- Pause for explicit human confirmation before irreversible or outward-facing steps
  (`git push`, deploy, delete, sending to external services) — even mid-loop.
  Approval in one iteration does NOT carry over to the next.
- **Merging into a shared branch (`develop` / `main`) requires the head's remote CI to be
  green, confirmed mechanically** (`gh run watch <run-id> --exit-status` / `gh pr checks --watch`)
  before the merge. Red / not-yet-completed / undetectable → stop (fail-safe). This is procedure +
  machine check only — **no physical layer** backs it (hooks fire on Bash git/PR, not on CI
  status); do not present it as hook-enforced. Under `--vibing` this CI-green machine check is
  **not** relaxed — vibing drops invariant 4's pre-confirmation, not invariant 1's machine
  verification (ADR-015 / ADR-018).
- **Two enforcement layers, and their limit:** irreversible ops are guarded by a soft
  regime (these rules) AND a hard physical layer (hooks). The physical layer fires ONLY
  on Bash-routed git/PR and Edit/Write — NOT on MCP-routed push/PR, nor on deploy /
  migrate / rollback commands. Route push/PR through `gh` CLI; for deploy/migrate/rollback
  the stop is gate + procedure only (no physical layer). Never present a procedure-only
  stop as if a hook backs it.
- **Under `--vibing` (ADR-015):** the pre-confirmation above is dropped for **reversible**
  ops (PR push, auto-rollback-capable deploy) and replaced by post-hoc audit +
  auto-rollback + transcript record. **Unrecoverable ops keep the pre-confirmation gate**:
  external send, destructive migrate (DROP/RENAME/TRUNCATE…), and deploy with no detectable
  auto-rollback. Detection is by machine predicate with **fail-safe = gate** (undetectable
  or unparseable → stop). The physical-layer limit above is unchanged — vibing's PR→main is
  allowed only via the `pr-base-checker.py` marker on the Bash(gh CLI) route; MCP-routed PR,
  deploy, and migrate have no physical layer even under vibing.

## Single entry, single judge

- **Scope / size is judged once, at the entry, from investigation** — not re-judged
  downstream. When a higher layer has already decided scope (e.g. `/autorun` ran
  analysis/planning before delegating the code rung to `skills/loop-engineering`),
  the lower layer ADOPTS that decision and does NOT re-run its own sizing. Two judges
  of the same thing can disagree — collapse them to one (see [ADR-014](../docs/adr/014-loop-engineering-as-discipline.md)).
- **Gates are derived, not placed** — a boundary is a human gate IFF its done-condition
  is not machine-checkable (a direction judgment) or its action is irreversible. The
  four `/autorun` gates (requirements / design / PR / deploy) are the *consequence* of
  this rule applied to each phase, not an arbitrary choice.

## `/goal` completion-condition recipe

```
/goal <machine-checkable condition> or stop after <N> turns
```

Example: `/goal all tests in tests/auth pass and lint is clean, or stop after 15 turns`

- The condition must be provable from Claude's own output (run the test, show the
  result) — not "looks done".
- A fast model re-checks the condition after every turn and auto-clears the goal
  when it holds.

## Cost awareness

- Multi-agent fan-out can cost ~15x a single chat. Prefer the smallest fleet that
  covers the work, and report what was intentionally skipped — silent truncation
  reads as "covered everything" when it wasn't.

## Gated multi-phase autonomous runs (`/autorun`)

When `/autorun` runs a full pipeline (requirements → … → deploy/PR) per
`.claude/docs/autorun-flow.md`, this rule applies:

- **Gates (kind=gate)** = requirements, design, PR, deploy. These are the concrete
  application of "irreversible/outward-facing actions need confirmation" (PR/deploy)
  and "no machine test → keep a human" (requirements/design). Non-gate phases auto-connect.
- **Stop only on the whitelist** — the 8-item list in `.claude/docs/autorun-flow.md` "Whitelist of
  places it may stop" is the single source (it includes **remote CI red / not-yet-completed**,
  which is NOT relaxed by `--vibing`, ADR-018). Stopping anywhere else is a definition
  violation — detect and report it.
- **Hard stop is two-layer**: a per-phase budget (e.g. verify = 5 rounds) AND a whole-run
  budget (transition count + the session ceiling above). Either one triggers a stop.
- **Goal drift is two-layer**: structural (reached `goal_phase` as planned) AND content
  (each phase output maps to the confirmed requirement). Phase progress alone is NOT proof
  of non-drift.
- **Physical-layer scope (don't overstate)**: hooks (`pr-base-checker.py`,
  `git-destructive-blocker.py`) only fire on git/Bash-routed push/PR — NOT on deploy
  commands or MCP-routed push/PR. So push/PR must go through `gh` CLI (Bash); deploy's stop
  is gate + procedure only (no physical layer).
- **With `--vibing` (ADR-015)**: `resolve_kind` (defined in `.claude/docs/autorun-flow.md`)
  demotes pr and reversible deploy to `auto`; the gates that remain are requirements,
  design (when `design_needed`), and the unrecoverable-op gates. The two-layer hard stop is
  unchanged except the whole-run transition cap is raised (full-auto=24 / support=14); the
  session ceiling and per-phase budgets are NOT changed, so the time ceiling still bounds
  the run.

## Vibing residual risk (`--vibing` only)

Dropping invariant 4's pre-confirmation moves the only guard for reversible irreversible
ops to *after* the fact. Be honest about what that costs:

- The single point of failure is the gate-retention predicate set
  (`migrate_destructive` / `deploy_irreversible` / `external_send`). A false negative
  (treating an unrecoverable op as reversible) is an unrecoverable accident, so all three
  **fail safe = gate**: undetectable, untaken, or unparseable inputs stop the run.
- Auto-rollback only covers deploy-verification failure. **Data already sent externally and
  schema already DROPped cannot be rolled back** — that is exactly why those ops keep the
  pre-confirmation gate.
- The external-send / migrate / deploy gates have **no physical layer** (procedure only).
  Vibing's main PR is allowed only through the `gh` CLI marker; never claim a hook backs
  the procedure-only stops.
