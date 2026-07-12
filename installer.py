#!/usr/bin/env python3
"""Generic, copy-based installer for a Claude Code config "foundation" pack.

This module contains NO domain-specific content. It is parameterized entirely
by a `Pack` description (name, target kind, source repo, managed paths, an
optional settings fragment to merge). A concrete pack (e.g. "claude-core")
wires up a `Pack` instance and calls `main(pack, argv)` from its own thin
entry-point script (see install.py).

Design summary
--------------
- Everything is COPIED (not symlinked) from `repo_root` into the resolved
  target directory. A manifest file (`.<pack>.manifest.json`) at the target
  root records exactly which files this pack put there and their sha256, so
  later runs can tell NEW / UPDATE / UNCHANGED / COLLISION / LOCAL_MODIFIED /
  REMOVE_STALE apart.
- install/update always compute the full plan BEFORE writing anything
  (plan-then-apply). If the plan contains a COLLISION (an untracked file
  already sits at a path this pack wants to manage) or a LOCAL_MODIFIED file
  (the user edited a previously-installed file), the run aborts with exit
  code 3 and writes nothing -- unless `--force` is given, in which case the
  existing file is backed up first and then overwritten.
- Every write/delete is boundary-checked: the resolved path must be inside
  the resolved target directory, or the operation refuses to proceed.
- `settings.json` is never blindly overwritten. Only the fragment's own keys
  are merged in (see `_merge_settings_dict`), a live key is never deleted,
  and the file is backed up first.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Plan action labels
# ---------------------------------------------------------------------------

NEW = "NEW"
UPDATE = "UPDATE"
UNCHANGED = "UNCHANGED"
COLLISION = "COLLISION"
LOCAL_MODIFIED = "LOCAL_MODIFIED"
REMOVE_STALE = "REMOVE_STALE"
STALE_LOCAL_MODIFIED = "STALE_LOCAL_MODIFIED"

_PLAN_ORDER = (
    NEW,
    UPDATE,
    UNCHANGED,
    COLLISION,
    LOCAL_MODIFIED,
    REMOVE_STALE,
    STALE_LOCAL_MODIFIED,
)

_BLOCKING_ACTIONS = (COLLISION, LOCAL_MODIFIED)

EXIT_OK = 0
EXIT_USAGE_ERROR = 1
EXIT_APPLY_ERROR = 2
EXIT_CONFLICT = 3


class UsageError(Exception):
    """Raised for bad CLI arguments / target resolution problems."""


class BoundaryViolation(Exception):
    """Raised if an operation would write/delete outside the resolved target."""


# ---------------------------------------------------------------------------
# Pack description
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Pack:
    name: str
    kind: str  # "global" | "project"
    repo_root: Path
    managed_paths: List[str]
    settings_fragment: Optional[str] = None
    other_domain_manifests: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.kind not in ("global", "project"):
            raise ValueError(f"unknown pack kind: {self.kind!r}")

    @property
    def manifest_name(self) -> str:
        return f".{self.name}.manifest.json"

    @property
    def backup_root_name(self) -> str:
        return f".{self.name}.backup"


@dataclass(frozen=True)
class PlanEntry:
    rel: str
    action: str
    src_hash: Optional[str] = None
    recorded_hash: Optional[str] = None


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%dT%H%M%S%f")


def _git_revision(repo_root: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    if completed.returncode == 0:
        rev = completed.stdout.strip()
        if rev:
            return rev
    return "unknown"


def path_within_target(target: Path, candidate: Path) -> Path:
    """Resolve `candidate` and assert it lives inside resolved `target`.

    Returns the resolved path on success; raises BoundaryViolation otherwise.
    This is the boundary guard used before every write/delete.
    """
    target_r = target.resolve()
    candidate_r = candidate.resolve()
    try:
        candidate_r.relative_to(target_r)
    except ValueError:
        raise BoundaryViolation(
            f"refusing to write outside target: {candidate_r} is not inside {target_r}"
        ) from None
    return candidate_r


# ---------------------------------------------------------------------------
# Managed source discovery
# ---------------------------------------------------------------------------


def discover_managed_files(pack: Pack) -> Dict[str, Path]:
    """Every regular file under pack.managed_paths, keyed by path relative to
    repo_root (POSIX string). Excludes the settings fragment file itself.
    """
    result: Dict[str, Path] = {}
    fragment_rel = pack.settings_fragment
    for name in pack.managed_paths:
        base = pack.repo_root / name
        if base.is_file():
            rel = name
            if fragment_rel and rel == fragment_rel:
                continue
            result[rel] = base
        elif base.is_dir():
            for p in sorted(base.rglob("*")):
                if not p.is_file():
                    continue
                rel = p.relative_to(pack.repo_root).as_posix()
                if fragment_rel and rel == fragment_rel:
                    continue
                result[rel] = p
    return dict(sorted(result.items()))


# ---------------------------------------------------------------------------
# Manifest I/O
# ---------------------------------------------------------------------------


def load_manifest(target: Path, pack: Pack) -> Optional[dict]:
    path = target / pack.manifest_name
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f"warning: manifest at {path} is present but corrupt/unreadable "
            f"({exc}); treating as not installed.",
            file=sys.stderr,
        )
        return None


def write_manifest(target: Path, pack: Pack, data: dict) -> None:
    path = path_within_target(target, target / pack.manifest_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Plan computation (read-only)
# ---------------------------------------------------------------------------


def compute_plan(
    pack: Pack, target: Path, managed: Dict[str, Path], installed: Optional[dict]
) -> List[PlanEntry]:
    installed_files = (installed or {}).get("files", {})
    entries: List[PlanEntry] = []

    for rel, src_path in managed.items():
        src_hash = sha256_file(src_path)
        tgt_path = target / rel
        recorded = installed_files.get(rel)
        # Symlink-aware existence: Path.exists() follows symlinks and reports
        # False for a *broken* symlink, which would otherwise misclassify a
        # symlink planted at a managed path as NEW and let it be written
        # through. is_symlink() never follows, so this is true whenever
        # something (even a dangling link) sits at tgt_path.
        is_symlink = tgt_path.is_symlink()
        lexists = is_symlink or tgt_path.exists()
        if not lexists:
            action = NEW
        elif recorded is None:
            # Untracked pre-existing entry -- a symlink (broken or not) is
            # never followed/overwritten; an untracked regular file is
            # likewise a collision.
            action = COLLISION
        elif is_symlink:
            # This pack previously installed a plain file here; something has
            # since replaced it with a symlink -- treat as a local edit.
            action = LOCAL_MODIFIED
        else:
            tgt_hash = sha256_file(tgt_path)
            if tgt_hash != recorded:
                action = LOCAL_MODIFIED
            elif src_hash == recorded:
                action = UNCHANGED
            else:
                action = UPDATE
        entries.append(PlanEntry(rel, action, src_hash, recorded))

    managed_rels = set(managed.keys())
    for rel, recorded in installed_files.items():
        if rel in managed_rels:
            continue
        tgt_path = target / rel
        if not tgt_path.exists():
            entries.append(PlanEntry(rel, REMOVE_STALE, None, recorded))
            continue
        tgt_hash = sha256_file(tgt_path)
        if tgt_hash == recorded:
            entries.append(PlanEntry(rel, REMOVE_STALE, None, recorded))
        else:
            entries.append(PlanEntry(rel, STALE_LOCAL_MODIFIED, None, recorded))

    return entries


def _print_plan(pack: Pack, target: Path, entries: List[PlanEntry]) -> None:
    by_action = {a: [e.rel for e in entries if e.action == a] for a in _PLAN_ORDER}
    print(f"=== {pack.name}: plan for {target} ===")
    any_entries = False
    for action in _PLAN_ORDER:
        rels = by_action[action]
        if not rels:
            continue
        any_entries = True
        print(f"[{action}] ({len(rels)})")
        for rel in rels:
            print(f"  - {rel}")
    if not any_entries:
        print("(no managed files found)")
    counts = ", ".join(f"{a}={len(by_action[a])}" for a in _PLAN_ORDER if by_action[a])
    print(f"summary: {counts if counts else 'no changes'}")


# ---------------------------------------------------------------------------
# Apply (writes)
# ---------------------------------------------------------------------------


def apply_plan(
    pack: Pack,
    target: Path,
    entries: List[PlanEntry],
    managed: Dict[str, Path],
    force: bool,
    backup_dir: Path,
    progress: Dict[str, str],
) -> bool:
    """Apply a previously-computed plan.

    `progress` is a caller-owned {rel: hash} map (typically seeded with the
    previously-installed files) that this function mutates IN PLACE as each
    file actually lands on disk. If an exception (e.g. from shutil.copy2)
    propagates mid-loop, the caller still sees, in `progress`, exactly the
    files that made it to disk -- this is what makes a crash mid-apply
    recoverable: the caller can persist `progress` as the manifest even on
    failure, so a re-run classifies those files as UNCHANGED rather than
    LOCAL_MODIFIED.

    Returns whether any backup was written.
    """
    target.mkdir(parents=True, exist_ok=True)
    backup_used = False

    def _backup_if_exists(tgt_path: Path, rel: str) -> None:
        nonlocal backup_used
        if tgt_path.exists():
            dest = path_within_target(target, backup_dir / rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tgt_path, dest)
            backup_used = True

    for e in entries:
        tgt_path = target / e.rel

        if e.action in (NEW, UPDATE):
            path_within_target(target, tgt_path)
            _backup_if_exists(tgt_path, e.rel)
            tgt_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(managed[e.rel], tgt_path)
            progress[e.rel] = e.src_hash

        elif e.action in _BLOCKING_ACTIONS:
            if force:
                if tgt_path.is_symlink():
                    # Never copy2 *through* a symlink (it could point outside
                    # the target): back up what it currently resolves to,
                    # unlink the link itself, then re-resolve -- now that the
                    # leaf is gone, resolution can't escape through it -- and
                    # write a real file in its place.
                    _backup_if_exists(tgt_path, e.rel)
                    tgt_path.unlink()
                    resolved = path_within_target(target, tgt_path)
                else:
                    resolved = path_within_target(target, tgt_path)
                    _backup_if_exists(tgt_path, e.rel)
                resolved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(managed[e.rel], resolved)
                progress[e.rel] = e.src_hash
            # else: unreachable in practice -- caller aborts before calling
            # apply_plan when blocking entries exist and force is False.

        elif e.action == UNCHANGED:
            progress[e.rel] = e.src_hash

        elif e.action == REMOVE_STALE:
            path_within_target(target, tgt_path)
            _backup_if_exists(tgt_path, e.rel)
            if tgt_path.exists():
                tgt_path.unlink()
            progress.pop(e.rel, None)

        elif e.action == STALE_LOCAL_MODIFIED:
            if force:
                path_within_target(target, tgt_path)
                _backup_if_exists(tgt_path, e.rel)
                if tgt_path.exists():
                    tgt_path.unlink()
                progress.pop(e.rel, None)
            # else: leave the locally-modified stale file in place, and keep
            # its manifest entry so subsequent runs keep reporting it.

    _prune_empty_dirs(pack, target)
    return backup_used


def _prune_empty_dirs(pack: Pack, target: Path) -> None:
    for name in pack.managed_paths:
        base = target / name
        if not base.is_dir():
            continue
        subdirs = sorted(
            (p for p in base.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts),
            reverse=True,
        )
        for d in subdirs:
            try:
                next(d.iterdir())
            except StopIteration:
                d.rmdir()
            except FileNotFoundError:
                pass
        try:
            next(base.iterdir())
        except StopIteration:
            base.rmdir()
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# settings.json merge
# ---------------------------------------------------------------------------

_PER_KEY_UNION_KEYS = ("env", "enabledPlugins", "extraKnownMarketplaces")
_FORCE_HOOK_EVENTS = ("PreToolUse", "PostToolUse")


def _merge_settings_dict(live: dict, fragment: dict) -> dict:
    result: dict = {}
    keys = list(dict.fromkeys(list(live.keys()) + list(fragment.keys())))

    for key in keys:
        if key in _PER_KEY_UNION_KEYS:
            live_v = live.get(key) or {}
            frag_v = fragment.get(key) or {}
            result[key] = {**live_v, **frag_v}

        elif key == "permissions":
            live_perm = live.get("permissions") or {}
            frag_perm = fragment.get("permissions") or {}
            merged_perm: dict = {}
            perm_keys = list(dict.fromkeys(list(live_perm.keys()) + list(frag_perm.keys())))
            for pk in perm_keys:
                if pk in ("allow", "deny"):
                    live_list = list(live_perm.get(pk) or [])
                    frag_list = list(frag_perm.get(pk) or [])
                    merged_list = list(live_list)
                    for item in frag_list:
                        if item not in merged_list:
                            merged_list.append(item)
                    merged_perm[pk] = merged_list
                else:
                    # defaultMode and any other permissions key are a personal
                    # setting: live always wins, fragment only fills when absent.
                    merged_perm[pk] = live_perm[pk] if pk in live_perm else frag_perm.get(pk)
            result["permissions"] = merged_perm

        elif key == "hooks":
            live_hooks = live.get("hooks") or {}
            frag_hooks = fragment.get("hooks") or {}
            merged_hooks = dict(live_hooks)
            for event in _FORCE_HOOK_EVENTS:
                if event in frag_hooks:
                    merged_hooks[event] = frag_hooks[event]
            for event, value in frag_hooks.items():
                if event not in _FORCE_HOOK_EVENTS and event not in merged_hooks:
                    merged_hooks[event] = value
            result["hooks"] = merged_hooks

        else:
            result[key] = live[key] if key in live else fragment.get(key)

    return result


def _load_fragment(fragment_path: Path, target: Path) -> dict:
    text = fragment_path.read_text(encoding="utf-8")
    text = text.replace("__TARGET__", str(target))
    return json.loads(text)


def merge_settings(fragment_path: Path, target: Path, backup_dir: Path) -> bool:
    """Merge fragment_path into <target>/settings.json. Returns whether a
    backup of the previous settings.json was written.

    If an existing settings.json is present but not valid JSON, the merge is
    skipped entirely and the file is left byte-for-byte untouched -- merging
    against a fragment would otherwise silently drop every live key."""
    fragment = _load_fragment(fragment_path, target)

    settings_path = path_within_target(target, target / "settings.json")
    live: dict = {}
    backed_up = False
    if settings_path.exists():
        try:
            live = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(
                f"warning: existing settings.json at {settings_path} is not "
                "valid JSON; skipping settings merge (file left untouched).",
                file=sys.stderr,
            )
            return False
        dest = path_within_target(target, backup_dir / "settings.json")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(settings_path, dest)
        backed_up = True

    merged = _merge_settings_dict(live, fragment)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return backed_up


def _print_settings_dry_run(fragment_path: Path, target: Path) -> None:
    fragment = _load_fragment(fragment_path, target)
    settings_path = target / "settings.json"
    live = {}
    if settings_path.exists():
        try:
            live = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(
                f"warning: existing settings.json at {settings_path} is not "
                "valid JSON; skipping settings merge preview (file would be "
                "left untouched).",
                file=sys.stderr,
            )
            return
    merged = _merge_settings_dict(live, fragment)
    print("=== settings.json merge (dry-run, nothing written) ===")
    print(json.dumps(merged, indent=2, ensure_ascii=False, sort_keys=True))


# ---------------------------------------------------------------------------
# Cross-domain refusal
# ---------------------------------------------------------------------------


def _cross_domain_conflict(pack: Pack, target: Path) -> Optional[str]:
    for name in pack.other_domain_manifests:
        if (target / name).exists():
            return name
    return None


# ---------------------------------------------------------------------------
# install / update
# ---------------------------------------------------------------------------


def install_or_update(pack: Pack, target: Path, force: bool, dry_run: bool) -> int:
    if pack.other_domain_manifests and target.exists():
        conflict = _cross_domain_conflict(pack, target)
        if conflict:
            print(
                f"refused: {target} is managed by another domain pack "
                f"(found {conflict}); {pack.name} will not install here.",
                file=sys.stderr,
            )
            return EXIT_USAGE_ERROR

    managed = discover_managed_files(pack)
    installed = load_manifest(target, pack)
    entries = compute_plan(pack, target, managed, installed)
    _print_plan(pack, target, entries)

    blocking = [e for e in entries if e.action in _BLOCKING_ACTIONS]
    if blocking and not force:
        print(
            f"\nABORT: {len(blocking)} conflicting file(s) (COLLISION/LOCAL_MODIFIED). "
            "Nothing was written. Re-run with --force to back up and overwrite.",
            file=sys.stderr,
        )
        return EXIT_CONFLICT

    if dry_run:
        if pack.settings_fragment:
            fragment_path = pack.repo_root / pack.settings_fragment
            if fragment_path.exists():
                _print_settings_dry_run(fragment_path, target)
        print("\n(dry-run: nothing written)")
        return EXIT_OK

    ts = _timestamp()
    backup_dir = target / pack.backup_root_name / ts

    # Seeded with whatever was already installed, then mutated in place by
    # apply_plan as each file actually lands on disk -- so if apply/merge
    # raises mid-way, `progress` still holds an accurate account of what
    # really reached disk (see the except Exception branch below).
    progress: Dict[str, str] = dict((installed or {}).get("files", {}))
    backup_used = False

    try:
        files_backed_up = apply_plan(pack, target, entries, managed, force, backup_dir, progress)

        settings_backed_up = False
        if pack.settings_fragment:
            fragment_path = pack.repo_root / pack.settings_fragment
            if fragment_path.exists():
                settings_backed_up = merge_settings(fragment_path, target, backup_dir)
        backup_used = files_backed_up or settings_backed_up
    except BoundaryViolation as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE_ERROR
    except Exception as exc:
        # Crash-consistency: some files may already be on disk even though
        # the overall apply failed. Persist the manifest we actually reached
        # so a re-run classifies those files as UNCHANGED, not LOCAL_MODIFIED.
        manifest = {
            "pack": pack.name,
            "revision": _git_revision(pack.repo_root),
            "installed_at": datetime.now().isoformat(),
            "target": str(target),
            "backup": str(backup_dir) if backup_used else None,
            "files": progress,
        }
        write_manifest(target, pack, manifest)
        print(
            f"error: install/update failed mid-way ({exc}); manifest updated to "
            f"reflect the {len(progress)} file(s) actually written to disk. "
            "Re-run to resume.",
            file=sys.stderr,
        )
        return EXIT_APPLY_ERROR

    manifest = {
        "pack": pack.name,
        "revision": _git_revision(pack.repo_root),
        "installed_at": datetime.now().isoformat(),
        "target": str(target),
        "backup": str(backup_dir) if backup_used else None,
        "files": progress,
    }
    write_manifest(target, pack, manifest)

    print(f"\n{pack.name}: install/update complete -> {target}")
    return EXIT_OK


# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------


def uninstall(pack: Pack, target: Path, force: bool, dry_run: bool) -> int:
    installed = load_manifest(target, pack)
    if installed is None:
        print(f"{pack.name}: no manifest found at {target} (not installed)")
        return EXIT_OK

    files = installed.get("files", {})

    # Pre-validate every manifest rel BEFORE touching disk: a manifest entry
    # that escapes the target (e.g. hand-edited/corrupted to contain "../evil"
    # or an absolute path) must never be followed. Filtering here -- rather
    # than discovering the violation mid-delete-loop -- means a bad entry can
    # never leave the loop having half-deleted things.
    safe_files: Dict[str, str] = {}
    for rel, recorded in files.items():
        try:
            path_within_target(target, target / rel)
        except BoundaryViolation:
            print(
                f"warning: manifest entry {rel!r} escapes the target directory; "
                "skipping (not deleted).",
                file=sys.stderr,
            )
            continue
        safe_files[rel] = recorded

    entries: List[PlanEntry] = []
    for rel, recorded in safe_files.items():
        tgt_path = target / rel
        if not tgt_path.exists():
            entries.append(PlanEntry(rel, "SKIP_MISSING", None, recorded))
        else:
            h = sha256_file(tgt_path)
            if h == recorded:
                entries.append(PlanEntry(rel, "REMOVE", None, recorded))
            else:
                entries.append(PlanEntry(rel, "LOCAL_MODIFIED", None, recorded))

    print(f"=== {pack.name}: uninstall plan for {target} ===")
    for action in ("REMOVE", "LOCAL_MODIFIED", "SKIP_MISSING"):
        rels = [e.rel for e in entries if e.action == action]
        if rels:
            print(f"[{action}] ({len(rels)})")
            for rel in rels:
                print(f"  - {rel}")

    if dry_run:
        print("\n(dry-run: nothing written)")
        return EXIT_OK

    ts = _timestamp()
    backup_dir = target / pack.backup_root_name / ts
    left_modified: List[str] = []

    for e in entries:
        tgt_path = target / e.rel
        if e.action == "REMOVE" or (e.action == "LOCAL_MODIFIED" and force):
            path_within_target(target, tgt_path)
            dest = path_within_target(target, backup_dir / e.rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tgt_path, dest)
            tgt_path.unlink()
        elif e.action == "LOCAL_MODIFIED":
            left_modified.append(e.rel)
        # SKIP_MISSING: nothing to do.

    _prune_empty_dirs(pack, target)

    manifest_path = target / pack.manifest_name
    if manifest_path.exists():
        manifest_path.unlink()

    if left_modified:
        print(
            "note: left in place (locally modified, use --force to remove): "
            + ", ".join(left_modified)
        )
    print(
        "note: settings.json keys were left untouched on uninstall "
        "(Claude may depend on live keys at runtime)."
    )
    print(f"{pack.name}: uninstall complete -> {target}")
    return EXIT_OK


# ---------------------------------------------------------------------------
# verify (read-only)
# ---------------------------------------------------------------------------


def verify(pack: Pack, target: Path) -> int:
    installed = load_manifest(target, pack)
    if installed is None:
        print(f"{pack.name}: not installed at {target}")
        return EXIT_OK

    files = installed.get("files", {})
    missing: List[str] = []
    modified: List[str] = []
    ok: List[str] = []
    for rel, recorded in sorted(files.items()):
        tgt_path = target / rel
        if not tgt_path.exists():
            missing.append(rel)
        elif sha256_file(tgt_path) != recorded:
            modified.append(rel)
        else:
            ok.append(rel)

    unknown: List[str] = []
    for name in pack.managed_paths:
        base = target / name
        if base.is_file():
            if name not in files:
                unknown.append(name)
        elif base.is_dir():
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    rel = p.relative_to(target).as_posix()
                    if rel not in files:
                        unknown.append(rel)

    print(f"=== {pack.name}: verify {target} ===")
    print(f"OK: {len(ok)}")
    if modified:
        print(f"MODIFIED: {len(modified)}")
        for rel in modified:
            print(f"  - {rel}")
    if missing:
        print(f"MISSING: {len(missing)}")
        for rel in missing:
            print(f"  - {rel}")
    if unknown:
        print(f"UNKNOWN: {len(unknown)}")
        for rel in unknown:
            print(f"  - {rel}")

    return EXIT_OK if not (missing or modified or unknown) else 1


# ---------------------------------------------------------------------------
# Target resolution + CLI entry point
# ---------------------------------------------------------------------------


def resolve_target(pack: Pack, project: Optional[str], target_arg: Optional[str]) -> Path:
    if pack.kind == "global":
        if project:
            raise UsageError("core は ~/.claude 専用 (--project は指定できません)")
        target = Path(target_arg) if target_arg else (Path.home() / ".claude")
    else:  # "project"
        if not project and not target_arg:
            raise UsageError("--project /abs/path が必須")
        if project:
            if not Path(project).is_absolute():
                raise UsageError("--project は絶対パスが必須")
            target = Path(project) / ".claude"
        else:
            target = Path(target_arg)  # type: ignore[arg-type]
        if target_arg:
            target = Path(target_arg)
    return target.resolve()


def main(pack: Pack, argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog=f"install-{pack.name}")
    parser.add_argument(
        "action",
        nargs="?",
        default="install",
        choices=["install", "update", "uninstall", "verify"],
    )
    parser.add_argument("--project", default=None)
    parser.add_argument("--target", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")

    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        return code if code != 0 else EXIT_OK

    try:
        target = resolve_target(pack, args.project, args.target)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE_ERROR

    if args.action in ("install", "update"):
        return install_or_update(pack, target, force=args.force, dry_run=args.dry_run)
    if args.action == "uninstall":
        return uninstall(pack, target, force=args.force, dry_run=args.dry_run)
    if args.action == "verify":
        return verify(pack, target)

    print(f"error: unknown action {args.action!r}", file=sys.stderr)
    return EXIT_USAGE_ERROR
