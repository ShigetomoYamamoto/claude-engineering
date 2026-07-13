#!/usr/bin/env python3
"""Copy-based installer for the claude-engineering foundation.

Installs the engineering development workflow into ONE explicitly named project's
.claude directory. Requires --project /abs/path. Refuses a project already managed
by claude-work-agent. Never targets ~/.claude. See installer.py for the engine.
"""
from pathlib import Path
import sys
from installer import Pack, main

PACK = Pack(
    name="claude-engineering",
    kind="project",
    repo_root=Path(__file__).resolve().parent,
    managed_paths=["rules", "commands", "agents", "skills", "hooks", "workflows", "templates", "docs"],
    settings_fragment="settings-fragment.json",
    other_domain_manifests=[".claude-work-agent.manifest.json"],
)

_ACTIONS = ("install", "update", "uninstall", "verify")
_ALIAS = "claude-eng"


def _require_action(argv):
    """Require an explicit action verb (npm/git style).

    The shared engine (installer.py) defaults a missing action to "install"; this
    wrapper is stricter so a bare invocation prints usage instead of silently
    installing. Order-independent: the verb may appear before or after flags.
    """
    if any(a in _ACTIONS for a in argv):
        return
    print(
        f"usage: {_ALIAS} <{'|'.join(_ACTIONS)}> [--dry-run] [--force] [--project /abs/path]\n"
        f"no action given -- cd into your target project, then e.g. `{_ALIAS} install`.",
        file=sys.stderr,
    )
    sys.exit(2)


def _argv_with_cwd_default(argv):
    """Default the install target to the current directory.

    The shared engine (installer.py) requires an explicit absolute --project for
    project-kind packs. To let the user just `cd` into a target project and run the
    installer with no path, inject `--project <cwd>` when neither --project nor
    --target was given. Explicit flags always win and bypass the self-install guard.
    """
    gives_target = any(
        a in ("--project", "--target")
        or a.startswith("--project=")
        or a.startswith("--target=")
        for a in argv
    )
    if gives_target:
        return argv
    cwd = Path.cwd().resolve()
    repo_root = PACK.repo_root
    if cwd == repo_root or repo_root in cwd.parents:
        print(
            f"error: refusing to install into the foundation repo itself ({cwd}).\n"
            f"cd into your target project first, or pass --project /abs/path.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"note: no --project given; installing into current directory: {cwd}")
    return [*argv, "--project", str(cwd)]


if __name__ == "__main__":
    _require_action(sys.argv[1:])
    sys.exit(main(PACK, _argv_with_cwd_default(sys.argv[1:])))
