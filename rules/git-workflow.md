# Git Workflow

## Behavioral Rules (enforced for all agents)

These rules apply whenever any agent performs git operations — not just when `/commit-commands:commit`, `/create-branch`, or `/create-pr` is called explicitly.

### Commits
- **Always show the commit message to the user and get approval before committing.** Never commit silently.
  - **適用注記（公式 `/commit-commands:commit` との関係・2026-07-06）**: ユーザー自身がこのコマンドを起動した場合、その起動をそのコミット1回分の承認とみなす（公式コマンドは実行中に確認テキストを出力しない設計のため）。エージェントが自発的にコミットする経路では本規範どおり事前承認が必要（自走中は下記 Autonomous-run exception の包括承認が根拠）。
- Never stage `.env`, credential files, or any file matching `*.key`, `*.pem`, `*.secret`.
- If changes span multiple unrelated purposes, split into separate commits.
- Do not push after committing — the user pushes manually.
- **Autonomous-run exception:** during `/autorun`, the user grants a one-time blanket approval for auto-commits at startup; per-commit approval is then waived (the message is still shown in the transcript each time). Without that approval, commit becomes a gate. See `docs/adr/008-orchestration-declarative-flow.md`.

### Branches
- **Always branch from `develop`.** Pull the latest `develop` before creating any branch.
- Never create branches from `main` or `master` unless explicitly instructed.

### Pull Requests
- **Always show the PR title and description to the user and get approval before creating.**
- Base branch is always `develop`. Never open PRs directly to `main` or `master`.
- If there are uncommitted changes, stop and guide the user to run `/commit-commands:commit` first.
- Do not push unless the PR flow requires it, and confirm before doing so.
- **Exception — `/autorun --vibing` only:** vibing may open a PR to `main` via the
  `pr-base-checker.py` vibing marker (ADR-015). This is the *only* path that bypasses the
  develop-base rule, and it applies solely to vibing; normal usage and plain `/autorun`
  keep `develop` as base unchanged.

---

## Reference

Format details (Conventional Commits type table / branch naming conventions / PR description template) are documented in `~/.claude/skills/git-workflow/SKILL.md`. Refer to it when generating commit messages, branch names, or PR descriptions.

## コマンドの所在（公式委譲・[ADR-012](../docs/adr/012-official-plugins-for-git-review-security.md)）

- **コミット** → 公式 `/commit-commands:commit`（コミットのみ・push しない）。規約準拠は `commit-msg-convention.py` hook が機械的に担保。
- **マージ済みローカルブランチ掃除** → 公式 `/commit-commands:clean_gone`。
- **ブランチ作成** → 自作 `/create-branch`（develop 起点＋命名規約。公式に同等品なし）。
- **PR 作成** → 自作 `/create-pr`（develop ベース＋テンプレ＋承認）。公式 `/commit-commands:commit-push-pr` は `--base` を指定せず `pr-base-checker.py`（develop 強制）に弾かれ、かつ無確認 push/PR になるため採用しない。
- 上記すべてに対し、保護ブランチへの commit/push と非 develop への PR は hooks が決定的にブロックする（どのコマンド経由でも有効）。
- **自走/委譲時にメインが思考ティア(Opus/Fable)へエスカレーション中で VCS を直接実行できない場合(opus-execution-guard)** → `git-runner` サブエージェント(Sonnet)へ委譲。規約は hooks が担保し、コマンドの正(`/create-branch`・`/create-pr`・`/commit-commands:commit`)は不変。
