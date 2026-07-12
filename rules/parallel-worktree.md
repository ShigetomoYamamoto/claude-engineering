# Parallel Agents & Worktree Isolation

Rules for running multiple agents at once. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
is enabled, so parallel fan-out is the default for independent work — but parallel
writers that share one working tree corrupt each other. Isolate them.

## When to isolate (CRITICAL)

Use an isolated git worktree per agent when BOTH hold:

- The agents run concurrently, AND
- Two or more of them may write to the same files, or run builds that mutate shared state.

If the agents are read-only (search, review, analysis), do NOT isolate — sharing the
tree is cheaper and correct.

## How to isolate

- **Subagents (Agent tool / Workflow):** pass `isolation: "worktree"`. Each agent gets a
  fresh worktree, auto-removed if unchanged. Setup costs ~200-500ms + disk per agent, so
  use it only for the concurrent-writer case above — not for every fan-out.
- **Manual / long-lived work:** `git worktree add ../wt-<task> <branch>`, work there, then
  `git worktree remove ../wt-<task>` when done.

## Rules

1. Read-only parallel work shares the tree. Concurrent writers MUST be isolated.
2. One worktree = one task = one branch. Never point two worktrees at the same branch.
3. Merge back through normal git (commit on the branch -> PR), never by copying files
   between worktrees.
4. Clean up when the task ends (`git worktree remove`, or `git worktree prune` for stale ones).

## Relation to loops

A self-running loop that spawns parallel writers inherits this rule: isolate the writers,
and keep a single mechanical verifier (see `rules/loop-safety.md`).
