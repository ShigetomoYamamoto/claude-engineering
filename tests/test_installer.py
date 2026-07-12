#!/usr/bin/env python3
"""stdlib-only unittest suite for installer.py.

Every test builds a synthetic source repo and a synthetic target, both under
tempfile.TemporaryDirectory() -- never touches ~/.claude or any real config
path.
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from unittest import mock
import hashlib
from pathlib import Path

# Make sure `import installer` resolves to installer.py that lives next to
# this tests/ directory, regardless of how the test runner was invoked.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import installer  # noqa: E402
from installer import Pack  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class InstallerTestBase(unittest.TestCase):
    """Common synthetic source-repo/target fixture for every test."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.src = self.root / "src"
        self.target = self.root / "target"

        _write(self.src / "rules" / "a.md", "rule a v1\n")
        _write(self.src / "hooks" / "h.py", "print('hook v1')\n")

    def make_pack(self, **overrides) -> Pack:
        kwargs = dict(
            name="testpack",
            kind="global",
            repo_root=self.src,
            managed_paths=["rules", "hooks"],
            settings_fragment=None,
            other_domain_manifests=[],
        )
        kwargs.update(overrides)
        return Pack(**kwargs)

    def run_cli(self, pack: Pack, action: str, *, force: bool = False, dry_run: bool = False,
                extra=()) -> int:
        argv = [action, "--target", str(self.target)]
        if force:
            argv.append("--force")
        if dry_run:
            argv.append("--dry-run")
        argv.extend(extra)
        return installer.main(pack, argv)


class DryRunWritesNothingTest(InstallerTestBase):
    """Property 1: dry-run never writes anything."""

    def test_dry_run_writes_nothing(self):
        pack = self.make_pack()
        code = self.run_cli(pack, "install", dry_run=True)
        self.assertEqual(code, installer.EXIT_OK)
        self.assertFalse(self.target.exists())


class FreshInstallTest(InstallerTestBase):
    """Property 2: fresh install copies everything and records correct hashes."""

    def test_fresh_install(self):
        pack = self.make_pack()
        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)

        a = self.target / "rules" / "a.md"
        h = self.target / "hooks" / "h.py"
        self.assertTrue(a.exists())
        self.assertTrue(h.exists())
        self.assertEqual(a.read_text(encoding="utf-8"), "rule a v1\n")
        self.assertEqual(h.read_text(encoding="utf-8"), "print('hook v1')\n")

        manifest_path = self.target / pack.manifest_name
        self.assertTrue(manifest_path.exists())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["pack"], "testpack")
        self.assertEqual(set(manifest["files"].keys()), {"rules/a.md", "hooks/h.py"})
        self.assertEqual(manifest["files"]["rules/a.md"], _sha256(self.src / "rules" / "a.md"))
        self.assertEqual(manifest["files"]["hooks/h.py"], _sha256(self.src / "hooks" / "h.py"))


class IdempotentUpdateTest(InstallerTestBase):
    """Property 3: a second install/update with unchanged source is a no-op."""

    def test_idempotent_update(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        manifest_before = json.loads((self.target / pack.manifest_name).read_text(encoding="utf-8"))

        code = self.run_cli(pack, "update")
        self.assertEqual(code, installer.EXIT_OK)

        manifest_after = json.loads((self.target / pack.manifest_name).read_text(encoding="utf-8"))
        self.assertEqual(manifest_before["files"], manifest_after["files"])
        self.assertFalse((self.target / pack.backup_root_name).exists())


class SourceChangedUpdateTest(InstallerTestBase):
    """Property 4: a source change is picked up as UPDATE, old file backed up."""

    def test_source_changed_update(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")

        old_hash = _sha256(self.src / "rules" / "a.md")
        _write(self.src / "rules" / "a.md", "rule a v2\n")
        new_hash = _sha256(self.src / "rules" / "a.md")

        code = self.run_cli(pack, "update")
        self.assertEqual(code, installer.EXIT_OK)
        self.assertEqual((self.target / "rules" / "a.md").read_text(encoding="utf-8"), "rule a v2\n")

        manifest = json.loads((self.target / pack.manifest_name).read_text(encoding="utf-8"))
        self.assertEqual(manifest["files"]["rules/a.md"], new_hash)

        backup_root = self.target / pack.backup_root_name
        self.assertTrue(backup_root.exists())
        backed_up = list(backup_root.rglob("a.md"))
        self.assertEqual(len(backed_up), 1)
        self.assertEqual(_sha256(backed_up[0]), old_hash)


class CollisionProtectionTest(InstallerTestBase):
    """Property 5: an unknown pre-existing file at a managed path aborts install."""

    def test_collision_aborts_without_force(self):
        pack = self.make_pack()
        _write(self.target / "rules" / "a.md", "unknown pre-existing content\n")

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_CONFLICT)
        self.assertFalse((self.target / pack.manifest_name).exists())
        self.assertFalse((self.target / pack.backup_root_name).exists())
        self.assertEqual(
            (self.target / "rules" / "a.md").read_text(encoding="utf-8"),
            "unknown pre-existing content\n",
        )

    def test_collision_with_force_backs_up_and_overwrites(self):
        pack = self.make_pack()
        _write(self.target / "rules" / "a.md", "unknown pre-existing content\n")

        code = self.run_cli(pack, "install", force=True)
        self.assertEqual(code, installer.EXIT_OK)
        self.assertEqual((self.target / "rules" / "a.md").read_text(encoding="utf-8"), "rule a v1\n")

        backup_root = self.target / pack.backup_root_name
        backed_up = list(backup_root.rglob("a.md"))
        self.assertEqual(len(backed_up), 1)
        self.assertEqual(backed_up[0].read_text(encoding="utf-8"), "unknown pre-existing content\n")


class LocalModificationProtectionTest(InstallerTestBase):
    """Property 6: a user edit to an installed file blocks update unless --force."""

    def test_local_modification_aborts_without_force(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        (self.target / "hooks" / "h.py").write_text("locally edited\n", encoding="utf-8")

        code = self.run_cli(pack, "update")
        self.assertEqual(code, installer.EXIT_CONFLICT)
        self.assertEqual((self.target / "hooks" / "h.py").read_text(encoding="utf-8"), "locally edited\n")

    def test_local_modification_with_force_restores_pack_version(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        (self.target / "hooks" / "h.py").write_text("locally edited\n", encoding="utf-8")

        code = self.run_cli(pack, "update", force=True)
        self.assertEqual(code, installer.EXIT_OK)
        self.assertEqual(
            (self.target / "hooks" / "h.py").read_text(encoding="utf-8"), "print('hook v1')\n"
        )

        backup_root = self.target / pack.backup_root_name
        backed_up = list(backup_root.rglob("h.py"))
        self.assertTrue(any(p.read_text(encoding="utf-8") == "locally edited\n" for p in backed_up))


class UninstallBoundaryTest(InstallerTestBase):
    """Property 7: uninstall only removes files it owns; user/local-modified files survive."""

    def test_uninstall_removes_only_manifest_files(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        _write(self.target / "rules" / "unrelated_user_file.md", "user content\n")
        (self.target / "hooks" / "h.py").write_text("locally edited\n", encoding="utf-8")

        code = installer.main(pack, ["uninstall", "--target", str(self.target)])
        self.assertEqual(code, installer.EXIT_OK)

        # unmodified managed file removed
        self.assertFalse((self.target / "rules" / "a.md").exists())
        # manifest gone
        self.assertFalse((self.target / pack.manifest_name).exists())
        # unrelated user file survives
        self.assertTrue((self.target / "rules" / "unrelated_user_file.md").exists())
        # locally-modified managed file survives (reported), no --force given
        self.assertTrue((self.target / "hooks" / "h.py").exists())
        self.assertEqual((self.target / "hooks" / "h.py").read_text(encoding="utf-8"), "locally edited\n")

    def test_uninstall_force_removes_local_modifications_too(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        (self.target / "hooks" / "h.py").write_text("locally edited\n", encoding="utf-8")

        code = installer.main(pack, ["uninstall", "--target", str(self.target), "--force"])
        self.assertEqual(code, installer.EXIT_OK)
        self.assertFalse((self.target / "hooks" / "h.py").exists())

        backup_root = self.target / pack.backup_root_name
        backed_up = list(backup_root.rglob("h.py"))
        self.assertTrue(any(p.read_text(encoding="utf-8") == "locally edited\n" for p in backed_up))


class StaleRemovalTest(InstallerTestBase):
    """Property 8: a file removed from source is removed from target on update."""

    def test_stale_removal_on_update(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")

        old_hash = _sha256(self.src / "rules" / "a.md")
        (self.src / "rules" / "a.md").unlink()

        code = self.run_cli(pack, "update")
        self.assertEqual(code, installer.EXIT_OK)
        self.assertFalse((self.target / "rules" / "a.md").exists())

        manifest = json.loads((self.target / pack.manifest_name).read_text(encoding="utf-8"))
        self.assertNotIn("rules/a.md", manifest["files"])

        backup_root = self.target / pack.backup_root_name
        backed_up = list(backup_root.rglob("a.md"))
        self.assertEqual(len(backed_up), 1)
        self.assertEqual(_sha256(backed_up[0]), old_hash)

    def test_stale_local_modified_left_in_place_without_force(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")
        (self.target / "rules" / "a.md").write_text("edited before going stale\n", encoding="utf-8")
        (self.src / "rules" / "a.md").unlink()

        code = self.run_cli(pack, "update")
        self.assertEqual(code, installer.EXIT_OK)
        self.assertTrue((self.target / "rules" / "a.md").exists())
        self.assertEqual(
            (self.target / "rules" / "a.md").read_text(encoding="utf-8"),
            "edited before going stale\n",
        )


class TargetBoundaryTest(InstallerTestBase):
    """Property 9: the installer never writes outside the resolved target."""

    def test_boundary_guard_rejects_escaping_path(self):
        target = self.root / "boundary_target"
        target.mkdir()
        with self.assertRaises(installer.BoundaryViolation):
            installer.path_within_target(target, target.parent / "escaped.txt")

    def test_boundary_guard_allows_path_inside_target(self):
        target = self.root / "boundary_target2"
        target.mkdir()
        resolved = installer.path_within_target(target, target / "inside.txt")
        self.assertEqual(resolved, (target / "inside.txt").resolve())

    def test_boundary_guard_allows_target_root_itself(self):
        target = self.root / "boundary_target3"
        target.mkdir()
        resolved = installer.path_within_target(target, target)
        self.assertEqual(resolved, target.resolve())


class SettingsMergeTest(InstallerTestBase):
    """Property 10: settings.json fragment merges without clobbering live keys."""

    def test_settings_merge_preserves_live_keys(self):
        fragment = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{"type": "command", "command": "__TARGET__/hooks/h.py"}],
                    }
                ]
            },
            "env": {"FOO": "bar"},
            "permissions": {"allow": ["Bash(ls:*)"]},
        }
        _write(self.src / "settings-fragment.json", json.dumps(fragment))

        pack = self.make_pack(settings_fragment="settings-fragment.json")

        live_settings = {
            "model": "sonnet",
            "permissions": {"allow": ["Read(*)"]},
        }
        _write(self.target / "settings.json", json.dumps(live_settings))

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)

        merged = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        # live-only key survives untouched
        self.assertEqual(merged["model"], "sonnet")
        # permissions.allow is a union of live + fragment
        self.assertIn("Read(*)", merged["permissions"]["allow"])
        self.assertIn("Bash(ls:*)", merged["permissions"]["allow"])
        # env key from fragment present
        self.assertEqual(merged["env"]["FOO"], "bar")
        # __TARGET__ token replaced with the resolved target path
        pre_hooks = merged["hooks"]["PreToolUse"]
        self.assertEqual(
            pre_hooks[0]["hooks"][0]["command"], f"{self.target.resolve()}/hooks/h.py"
        )

        backup_root = self.target / pack.backup_root_name
        backups = list(backup_root.rglob("settings.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text(encoding="utf-8")), live_settings)

    def test_missing_fragment_is_a_silent_noop(self):
        # settings_fragment names a file that does not exist on disk -- must
        # not error, and settings.json must not be touched.
        pack = self.make_pack(settings_fragment="does-not-exist.json")
        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)
        self.assertFalse((self.target / "settings.json").exists())


class MalformedLiveSettingsTest(InstallerTestBase):
    """FIX 1: an unparseable live settings.json must never be dropped/overwritten."""

    def test_malformed_settings_json_left_untouched_and_warns(self):
        fragment = {"env": {"FOO": "bar"}}
        _write(self.src / "settings-fragment.json", json.dumps(fragment))
        pack = self.make_pack(settings_fragment="settings-fragment.json")

        bad_settings_text = "{not valid json at all"
        _write(self.target / "settings.json", bad_settings_text)

        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)
        self.assertTrue(buf.getvalue().strip(), "expected a warning on stderr")

        # settings.json is byte-for-byte untouched
        self.assertEqual(
            (self.target / "settings.json").read_text(encoding="utf-8"), bad_settings_text
        )

        # file install still completed
        self.assertTrue((self.target / "rules" / "a.md").exists())
        self.assertTrue((self.target / "hooks" / "h.py").exists())
        manifest_path = self.target / pack.manifest_name
        self.assertTrue(manifest_path.exists())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["files"].keys()), {"rules/a.md", "hooks/h.py"})

    def test_malformed_settings_json_dry_run_preview_leaves_it_untouched(self):
        fragment = {"env": {"FOO": "bar"}}
        _write(self.src / "settings-fragment.json", json.dumps(fragment))
        pack = self.make_pack(settings_fragment="settings-fragment.json")

        bad_settings_text = "{not valid json at all"
        _write(self.target / "settings.json", bad_settings_text)

        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            code = self.run_cli(pack, "install", dry_run=True)
        self.assertEqual(code, installer.EXIT_OK)
        self.assertTrue(buf.getvalue().strip(), "expected a warning on stderr")
        self.assertEqual(
            (self.target / "settings.json").read_text(encoding="utf-8"), bad_settings_text
        )


class PermissionsDenyUnionTest(InstallerTestBase):
    """FIX 3: permissions.deny must union like permissions.allow, not clobber."""

    def test_permissions_deny_union_and_allow_still_works(self):
        fragment = {"permissions": {"allow": ["Y_allow"], "deny": ["Y_deny"]}}
        _write(self.src / "settings-fragment.json", json.dumps(fragment))
        pack = self.make_pack(settings_fragment="settings-fragment.json")

        live_settings = {"permissions": {"allow": ["X_allow"], "deny": ["X_deny"]}}
        _write(self.target / "settings.json", json.dumps(live_settings))

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)

        merged = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(merged["permissions"]["deny"], ["X_deny", "Y_deny"])
        self.assertEqual(merged["permissions"]["allow"], ["X_allow", "Y_allow"])

    def test_permissions_default_mode_still_live_wins(self):
        fragment = {"permissions": {"defaultMode": "auto"}}
        _write(self.src / "settings-fragment.json", json.dumps(fragment))
        pack = self.make_pack(settings_fragment="settings-fragment.json")

        live_settings = {"permissions": {"defaultMode": "manual"}}
        _write(self.target / "settings.json", json.dumps(live_settings))

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_OK)

        merged = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(merged["permissions"]["defaultMode"], "manual")


class ManifestCorruptWarningTest(InstallerTestBase):
    """FIX 5: a present-but-corrupt manifest warns; a missing one stays quiet."""

    def test_corrupt_manifest_warns_and_is_treated_as_not_installed(self):
        pack = self.make_pack()
        self.target.mkdir(parents=True, exist_ok=True)
        _write(self.target / pack.manifest_name, "{not valid json")

        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            result = installer.load_manifest(self.target, pack)
        self.assertIsNone(result)
        self.assertTrue(buf.getvalue().strip(), "expected a warning on stderr")

    def test_missing_manifest_is_quiet(self):
        pack = self.make_pack()
        self.target.mkdir(parents=True, exist_ok=True)

        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            result = installer.load_manifest(self.target, pack)
        self.assertIsNone(result)
        self.assertEqual(buf.getvalue(), "")


class UninstallManifestBoundaryTest(InstallerTestBase):
    """FIX 5: uninstall must never delete a manifest entry that escapes target."""

    def test_uninstall_skips_manifest_entry_escaping_target(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")

        outside_evil = self.target.parent / "evil"
        _write(outside_evil, "should never be touched\n")

        manifest_path = self.target / pack.manifest_name
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"]["../evil"] = _sha256(outside_evil)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            code = installer.main(pack, ["uninstall", "--target", str(self.target)])
        self.assertEqual(code, installer.EXIT_OK)
        self.assertTrue(buf.getvalue().strip(), "expected a warning on stderr")

        # outside file untouched
        self.assertTrue(outside_evil.exists())
        self.assertEqual(outside_evil.read_text(encoding="utf-8"), "should never be touched\n")
        # valid entries still removed + manifest gone
        self.assertFalse((self.target / "rules" / "a.md").exists())
        self.assertFalse((self.target / "hooks" / "h.py").exists())
        self.assertFalse(manifest_path.exists())


class SymlinkCollisionTest(InstallerTestBase):
    """FIX 4: a symlink at a managed target path is a COLLISION, never followed."""

    def test_symlink_at_managed_path_is_collision_and_untouched(self):
        pack = self.make_pack()
        outside = self.root / "outside_secret.txt"
        _write(outside, "outside content\n")
        (self.target / "rules").mkdir(parents=True, exist_ok=True)
        (self.target / "rules" / "a.md").symlink_to(outside)

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_CONFLICT)
        self.assertTrue((self.target / "rules" / "a.md").is_symlink())
        self.assertEqual((self.target / "rules" / "a.md").resolve(), outside.resolve())
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside content\n")
        self.assertFalse((self.target / pack.manifest_name).exists())

    def test_broken_symlink_at_managed_path_is_collision_not_new(self):
        pack = self.make_pack()
        broken_target_path = self.root / "does_not_exist.txt"
        (self.target / "rules").mkdir(parents=True, exist_ok=True)
        (self.target / "rules" / "a.md").symlink_to(broken_target_path)

        code = self.run_cli(pack, "install")
        self.assertEqual(code, installer.EXIT_CONFLICT)
        self.assertTrue((self.target / "rules" / "a.md").is_symlink())
        self.assertFalse((self.target / pack.manifest_name).exists())

    def test_symlink_at_managed_path_with_force_replaces_with_real_file(self):
        pack = self.make_pack()
        outside = self.root / "outside_secret.txt"
        _write(outside, "outside content\n")
        (self.target / "rules").mkdir(parents=True, exist_ok=True)
        (self.target / "rules" / "a.md").symlink_to(outside)

        code = self.run_cli(pack, "install", force=True)
        self.assertEqual(code, installer.EXIT_OK)
        tgt = self.target / "rules" / "a.md"
        self.assertFalse(tgt.is_symlink())
        self.assertEqual(tgt.read_text(encoding="utf-8"), "rule a v1\n")
        # the outside destination must never have been written through
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside content\n")


class CrashConsistencyTest(InstallerTestBase):
    """FIX 2: the manifest must reflect exactly what actually reached disk."""

    def test_partial_apply_failure_persists_partial_manifest_and_resumes(self):
        pack = self.make_pack()
        call_count = {"n": 0}
        original_copy2 = installer.shutil.copy2

        def flaky_copy2(src, dst, *a, **kw):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise OSError("simulated disk failure")
            return original_copy2(src, dst, *a, **kw)

        with mock.patch.object(installer.shutil, "copy2", side_effect=flaky_copy2):
            code = self.run_cli(pack, "install")

        self.assertNotEqual(code, installer.EXIT_OK)

        # exactly one of the two managed files made it to disk (the 2nd
        # copy2 call failed before completing)
        a_exists = (self.target / "rules" / "a.md").exists()
        h_exists = (self.target / "hooks" / "h.py").exists()
        self.assertEqual([a_exists, h_exists].count(True), 1)

        manifest_path = self.target / pack.manifest_name
        self.assertTrue(manifest_path.exists(), "manifest must be written even on failure")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        written_rels = {rel for rel in ("rules/a.md", "hooks/h.py") if (self.target / rel).exists()}
        self.assertEqual(set(manifest["files"].keys()), written_rels)

        # a subsequent update (copy2 restored) must treat the already-written
        # file as UNCHANGED (not LOCAL_MODIFIED) and complete successfully.
        code2 = self.run_cli(pack, "update")
        self.assertEqual(code2, installer.EXIT_OK)
        self.assertTrue((self.target / "rules" / "a.md").exists())
        self.assertTrue((self.target / "hooks" / "h.py").exists())
        self.assertEqual(
            (self.target / "rules" / "a.md").read_text(encoding="utf-8"), "rule a v1\n"
        )
        self.assertEqual(
            (self.target / "hooks" / "h.py").read_text(encoding="utf-8"), "print('hook v1')\n"
        )


class CrossDomainRefusalTest(InstallerTestBase):
    """Property 11: a project-kind pack refuses to install where another domain owns the project."""

    def test_cross_domain_refusal(self):
        pack = self.make_pack(
            kind="project", other_domain_manifests=[".claude-work-agent.manifest.json"]
        )
        _write(self.target / ".claude-work-agent.manifest.json", json.dumps({"pack": "work-agent"}))

        code = installer.main(pack, ["install", "--target", str(self.target)])
        self.assertEqual(code, installer.EXIT_USAGE_ERROR)
        self.assertFalse((self.target / pack.manifest_name).exists())
        self.assertFalse((self.target / "rules" / "a.md").exists())


class TargetResolutionUsageTest(InstallerTestBase):
    """Property 12: project-kind requires --project/--target; global-kind rejects --project."""

    def test_project_kind_requires_project_or_target(self):
        pack = self.make_pack(kind="project")
        code = installer.main(pack, ["install"])
        self.assertEqual(code, installer.EXIT_USAGE_ERROR)

    def test_global_kind_rejects_project_flag(self):
        pack = self.make_pack(kind="global")
        code = installer.main(
            pack, ["install", "--project", str(self.root / "some-project"), "--target", str(self.target)]
        )
        self.assertEqual(code, installer.EXIT_USAGE_ERROR)
        self.assertFalse(self.target.exists())

    def test_project_kind_target_overrides_project(self):
        pack = self.make_pack(kind="project")
        code = installer.main(
            pack,
            [
                "install",
                "--project",
                str(self.root / "some-project"),
                "--target",
                str(self.target),
            ],
        )
        self.assertEqual(code, installer.EXIT_OK)
        # installed at the literal --target, not <project>/.claude
        self.assertTrue((self.target / "rules" / "a.md").exists())
        self.assertFalse((self.root / "some-project").exists())


class VerifyTest(InstallerTestBase):
    """Bonus coverage for the read-only verify action."""

    def test_verify_reports_ok_then_modified(self):
        pack = self.make_pack()
        self.run_cli(pack, "install")

        code_ok = installer.main(pack, ["verify", "--target", str(self.target)])
        self.assertEqual(code_ok, installer.EXIT_OK)

        (self.target / "hooks" / "h.py").write_text("tampered\n", encoding="utf-8")
        code_modified = installer.main(pack, ["verify", "--target", str(self.target)])
        self.assertEqual(code_modified, 1)

        # verify never writes
        self.assertEqual((self.target / "hooks" / "h.py").read_text(encoding="utf-8"), "tampered\n")


if __name__ == "__main__":
    unittest.main()
