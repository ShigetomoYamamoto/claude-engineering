# Agent Orchestration

## Pre-Implementation Branch Check (MANDATORY)

Before writing or editing any code file, always verify the current branch:

1. Run `git branch --show-current`
2. If the result is `main`, `master`, or `develop` — **STOP immediately**
   - Do NOT proceed with any file changes
   - Tell the user: "現在 protected branch にいます。作業ブランチを作成してから実装を開始します。"
   - Run `/create-branch` (or `git checkout -b <prefix>/<summary>_YYYYMMDD` if develop is unavailable)
   - Resume implementation only after confirming the new branch

This check applies to ALL agents that write or edit files.

---

## Proactive Agent Invocation

These agents MUST be invoked automatically — without waiting for the user to ask:

| Trigger | Agent to invoke |
|---------|----------------|
| User provides a free-form goal / new feature idea (full-auto mode start) | **requirements-analyst** — structure requirements before design |
| User provides a specific task / GitHub Issue / bug report (support mode start) | **task-analyst** — break down into implementable units before planning |
| New project, or feature requires new DB schema / API contract / tech stack decision | **architect** — requirements definition → design → ADR before anything else |
| Implementing a feature within an existing, defined design | **planner** — implementation plan before writing code |
| Fixing a bug or implementing a new feature | **tdd-guide** — enforce tests-first |
| Any code has been written or modified | **code-reviewer**（公式 `pr-review-toolkit` プラグイン提供）— review immediately after |
| Code touches auth, user input, secrets, or API endpoints | **security-reviewer** — review before committing (in addition to code-reviewer) |
| Build or type errors occur | **build-error-resolver** — fix before continuing |
| DB schema migrations pending or about to deploy | **migration-runner** — apply migrations safely |
| Ready to deploy after PR merge | **deploy-runner** — deploy + verify + auto-rollback on failure |
| Manual rollback needed after a previous deploy | **rollback-runner** — revert to a previous version |
| PR has reviewer comments that need addressing | **review-responder** — implement requested changes and reply |
| Main loop has escalated to a thinking-tier model (Fable/Opus) and needs VCS/release ops (commit/push/PR/branch/merge) but is blocked by opus-execution-guard | **git-runner** — delegate the git/gh execution (Sonnet; passes the agent_id gate) |
| Main loop has escalated to a thinking-tier model (Fable/Opus) and needs a generic edit / Bash that no specialist owns but is blocked by opus-execution-guard | **executor** — residual execution worker (Sonnet) |

> 自走時（`/autorun`）は `.claude/docs/autorun-flow.md` の遷移に従い、各エージェントがフェーズとして連結起動される（requirements→requirements-analyst, analyze-task→task-analyst, design→architect, plan→planner, tdd→loop-engineering, verify→/review-loop, deploy→deploy-runner 等）。上表のトリガー（コード変更時の即時レビュー等）はフェーズ内でなお有効。`/autorun --vibing` 時は方向ゲート（要件・条件付き設計）と巻き戻し不能操作以外の事前確認が外れる（[ADR-015](../docs/adr/015-vibing-mode.md)）が、各フェーズのエージェント連結とトリガーは同じ。

> **公式プラグインへの委譲（2026-06-19〜・[ADR-012](../docs/adr/012-official-plugins-for-git-review-security.md)）:** 「危険操作は hooks で決定的に制御／振る舞いは公式に寄せる」方針。コードレビューは公式 `pr-review-toolkit`（`code-reviewer` ほか専門エージェント群）、コミット/ブランチ掃除は公式 `commit-commands`（`/commit-commands:commit`・`clean_gone`）、セキュリティは公式 `security-guidance`（編集時警告＋commit時LLMレビュー）に委譲。一方 `security-reviewer`・`reviewer`・`fixer`・`/create-pr` は公式に同等品が無い（または develop ベース強制 hook と衝突する）ため**自作を維持**する。危険操作の確定的ブロックは hooks（`git-destructive-blocker`・`pr-base-checker`・`git-add-secret-blocker`・`commit-msg-convention` ほか）が担う。

> **物理層(hooks)のスコープ(過大に言わない・ADR-014):** hooks は **Bash 経由の git/PR と Edit/Write にのみ**作動する(settings の matcher が `Bash` / `Edit|Write|MultiEdit`)。**MCP 経由の push/PR(`mcp__plugin_github_github__create_pull_request` 等)・deploy/migrate/rollback コマンドには作動しない**。だから push/PR は `gh` CLI(Bash)に限定し、deploy/migrate/rollback の不可逆停止は「ゲート＋手続き」で担保する(物理層なし)。手続きだけの停止を「hooks が守る」と過信しないこと。

## Parallel Task Execution

Independent operations run as parallel Task calls (the harness default).

> Read-only fan-out shares the working tree. Concurrent **writers** must each
> run in an isolated worktree — see `rules/parallel-worktree.md`.
