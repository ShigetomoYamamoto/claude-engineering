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

if __name__ == "__main__":
    sys.exit(main(PACK, sys.argv[1:]))
