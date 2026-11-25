#!/usr/bin/env python3
"""stdlib-only unittest suite for settings-fragment.json.

Guards the permissions-hardening of ``permissions.allow`` (and that ``permissions.deny`` stays empty):
the pack grants only the git / gh operations it really uses, never a blanket
``Bash(git *)`` and the like. curl is never granted: any wildcard curl allow rule can
be widened by a later flag (a second ``-o``, ``-D``, ``--trace``, ``--output-dir``) or by
shell expansion in the URL, so the deploy-runner verification curls go through the normal
prompt / classifier. The pack ships no ``permissions.deny``: branch protection is git's own
hooks, and the Claude-side hook only blocks disabling them, so a blanket curl ban is out of
policy; ``install.py`` lists the withdrawn deny entries in ``retired_deny`` so ``update``
removes them from projects. Policy and rationale: README section
"権限 (`permissions.allow`) の方針".

Caveat: argument patterns are fragile and are not a security boundary. The
pattern-matching helpers below use ``fnmatch`` on the text between ``Bash(`` and
the closing ``)``; Claude Code's real matcher is NOT reproduced exactly, so those
tests are a sanity check of the pattern text, not proof of runtime behaviour.

Two layers, deliberately redundant:

* ``TestAllowExactSet`` is a CHANGE DETECTOR. Any grant change (add or remove)
  must be made consciously in ``EXPECTED_ALLOW`` below, in the same commit as
  the change to settings-fragment.json and the README section.
* ``TestAllowInvariants`` holds structural invariants that stay valid even when
  ``EXPECTED_ALLOW`` is edited, so a future edit cannot quietly reintroduce a
  blanket / dangerous grant by "just updating the expected set".

The checkers are pure functions over a list of rule strings, so
``TestCheckersBite`` can prove that they actually reject bad input.
"""

import fnmatch
import json
import os
import re
import unittest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))
FRAGMENT_PATH = os.path.join(_REPO_ROOT, "settings-fragment.json")

# curl allow entries this pack shipped earlier and withdrew. They must stay out of
# permissions.allow, and install.py must list them in retired_allow so `update` removes
# them from projects that already merged them.
RETIRED_CURL_ENTRIES = (
    "Bash(curl -sS --max-time * -o * -w *)",
    "Bash(curl -sS --head --max-time * -o /dev/null -w *)",
)

# curl deny entries this pack shipped earlier and withdrew (the last one is the unbalanced
# spelling released in 271d117). They must stay out of permissions.deny, and install.py must
# list them in retired_deny so `update` removes them from projects that already merged them.
RETIRED_CURL_DENY_ENTRIES = (
    "Bash(curl * -d*)", "Bash(curl * --data*)", "Bash(curl * --json*)", "Bash(curl * -F*)",
    "Bash(curl * --form*)", "Bash(curl * -T*)", "Bash(curl * --upload-file*)", "Bash(curl * -X*)",
    "Bash(curl * --request*)", "Bash(curl * -K*)", "Bash(curl * --config*)", "Bash(curl *@*)",
    "Bash(curl *$(*)", "Bash(curl *$(*)*)", "Bash(curl *`*)", "Bash(curl *..*)",
)

# The documented deploy-runner commands (agents/deploy-runner.md, verification step)
# with the placeholders filled in. They are no longer pre-approved (no allow rule may match
# them): they run after the normal prompt / classifier.
# Mirrored here on purpose rather than read from that file.
DEPLOY_RUNNER_CURL_COMMANDS = (
    "curl -sS --max-time 10 -o /tmp/body.txt -w '%{http_code}' https://example.invalid/health",
    "curl -sS --head --max-time 5 -o /dev/null -w '%{http_code} %{content_type}' https://example.invalid/app.js",
)

# CHANGE DETECTOR -- edit this set only as a deliberate permission decision, and
# update README section "権限 (`permissions.allow`) の方針" in the same change.
EXPECTED_ALLOW = frozenset(
    {
        # git: read-only inspection
        "Bash(git status *)",
        "Bash(git diff *)",
        "Bash(git log *)",
        "Bash(git show *)",
        "Bash(git branch *)",
        "Bash(git rev-parse *)",
        "Bash(git ls-files *)",
        # git: local working-tree / branch operations
        "Bash(git add *)",
        "Bash(git commit *)",
        "Bash(git checkout *)",
        "Bash(git switch *)",
        "Bash(git restore *)",
        "Bash(git worktree *)",
        # git: remote operations, bare or anchored on `origin` only
        "Bash(git fetch)",
        "Bash(git fetch origin *)",
        "Bash(git pull)",
        "Bash(git pull origin *)",
        "Bash(git push)",
        "Bash(git push origin *)",
        "Bash(git push -u origin *)",
        # gh: PR / issue / run, read-mostly plus `pr create`
        "Bash(gh pr create *)",
        "Bash(gh pr view *)",
        "Bash(gh pr checks *)",
        "Bash(gh pr list *)",
        "Bash(gh pr diff *)",
        "Bash(gh issue view *)",
        "Bash(gh issue list *)",
        "Bash(gh run watch *)",
        "Bash(gh run view *)",
        "Bash(gh run list *)",
    }
)

# CHANGE DETECTOR for permissions.deny -- the pack ships none (see the module docstring).
EXPECTED_DENY = frozenset()

BLANKET_FORMS = frozenset(
    {
        "Bash(git *)",
        "Bash(gh *)",
        "Bash(claude *)",
        "Bash(curl *)",
        "Bash(curl:*)",
        "Bash(*)",
        # legacy prefix-match spelling of the same blanket grants
        "Bash(git:*)",
        "Bash(gh:*)",
    }
)

FORBIDDEN_TOOLS = frozenset(
    {"claude", "wget", "sh", "bash", "python", "python3", "node", "npx"}
)

# Tools whose rules get the structural git/gh shape checks.
GIT_GH_TOOLS = frozenset({"git", "gh"})

# Only git / gh are granted. curl is never granted (see curl_violations).
ALLOWED_TOOLS = GIT_GH_TOOLS

FORBIDDEN_GIT_SUBCOMMANDS = frozenset(
    {
        "config", "remote", "alias", "filter-branch", "submodule", "reset",
        "clean", "rm", "rebase", "merge", "cherry-pick", "stash", "tag",
        "daemon", "difftool", "mergetool", "am", "apply",
    }
)

FORBIDDEN_GH_GROUPS = frozenset(
    {
        "api", "auth", "alias", "extension", "secret", "ssh-key", "gpg-key",
        "repo", "workflow", "release", "codespace", "config",
    }
)

FORBIDDEN_GH_ACTIONS = {
    "pr": frozenset(
        {"merge", "edit", "close", "comment", "review", "ready", "reopen",
         "revert", "lock", "update-branch"}
    ),
    "issue": frozenset(
        {"create", "edit", "close", "comment", "delete", "reopen", "lock", "transfer"}
    ),
    "run": frozenset({"rerun", "cancel", "delete"}),
}

# git subcommands that name a remote; the grant must be bare or `origin`-anchored.
REMOTE_SUBCOMMANDS = frozenset({"push", "fetch", "pull"})

_ENTRY_RE = re.compile(r"^(?P<tool>[A-Za-z_][A-Za-z0-9_]*)\((?P<spec>.*)\)$", re.DOTALL)
_SUBCOMMAND_RE = re.compile(r"^[a-z][a-z0-9-]*$")
# A non-wildcard token: a word or a short/long option made of plain characters.
# Shell metacharacters (; & | $ ` < > ( ) quotes, glob chars) cannot match.
_PLAIN_TOKEN_RE = re.compile(r"^-{0,2}[A-Za-z0-9][A-Za-z0-9_-]*$")


# --------------------------------------------------------------------------
# Pure checkers: take a list of rule strings, return a list of violation texts
# (empty list == compliant).
# --------------------------------------------------------------------------

def _parse_bash(entry):
    """Return the space-split tokens of a ``Bash(...)`` rule, else None."""
    if not isinstance(entry, str):
        return None
    m = _ENTRY_RE.match(entry)
    if m is None or m.group("tool") != "Bash":
        return None
    return m.group("spec").split(" ")


def _git_gh_entries(allow):
    """Yield (entry, tokens) for parseable Bash rules whose tool is git or gh."""
    for entry in allow:
        tokens = _parse_bash(entry)
        if tokens is not None and tokens[0] in GIT_GH_TOOLS:
            yield entry, tokens


def exact_set_diff(allow):
    """Return (unexpected, missing) relative to EXPECTED_ALLOW."""
    actual = set(allow)
    return sorted(actual - EXPECTED_ALLOW), sorted(EXPECTED_ALLOW - actual)


def deny_set_diff(deny):
    """Return (unexpected, missing) relative to EXPECTED_DENY."""
    actual = set(deny)
    return sorted(actual - EXPECTED_DENY), sorted(EXPECTED_DENY - actual)


def blanket_violations(allow):
    return [
        f"{entry!r} is a blanket grant (lets any prompt-injected sub-command run unprompted)"
        for entry in allow
        if entry in BLANKET_FORMS
    ]


def tool_violations(allow):
    out = []
    for entry in allow:
        tokens = _parse_bash(entry)
        if tokens is None:
            out.append(f"{entry!r} is not a Bash(...) rule; the pack grants git/gh via Bash only")
        elif tokens[0] in FORBIDDEN_TOOLS:
            out.append(f"{entry!r} grants the forbidden tool {tokens[0]!r}")
        elif tokens[0] not in ALLOWED_TOOLS:
            out.append(f"{entry!r} grants tool {tokens[0]!r}; only git / gh are allowed")
    return out


def curl_violations(allow):
    """No curl form may be granted at all (including the legacy ``curl:*`` prefix
    spelling and the retired entries in RETIRED_CURL_ENTRIES): a wildcard curl allow
    rule can always be widened by a later flag or by shell expansion in the URL."""
    out = []
    for entry in allow:
        tokens = _parse_bash(entry)
        if tokens is None:
            continue
        if tokens[0] == "curl" or tokens[0].startswith("curl:"):
            out.append(f"{entry!r} grants curl; curl must go through the normal prompt / classifier")
    return out


def _spec(entry):
    """Text between `Bash(` and the closing `)`, or None for a non-Bash rule."""
    if isinstance(entry, str) and entry.startswith("Bash(") and entry.endswith(")"):
        return entry[len("Bash("):-1]
    return None


def rule_matches(entry, command):
    """fnmatch-style match of a command against a `Bash(...)` rule.

    Approximation only: Claude Code's real matcher is not reproduced exactly
    (word-boundary rules for a trailing ` *`, compound-command splitting, ...).
    """
    spec = _spec(entry)
    return spec is not None and fnmatch.fnmatchcase(command, spec)


def shape_violations(allow):
    """Literal subcommand, wildcard only as the final bare `*`, plain tokens."""
    out = []
    for entry, tokens in _git_gh_entries(allow):
        last = len(tokens) - 1
        if len(tokens) < 2:
            out.append(f"{entry!r} names no subcommand")
            continue
        if tokens[1] == "*" or tokens[1].startswith("-") or not _SUBCOMMAND_RE.match(tokens[1]):
            out.append(
                f"{entry!r}: second word {tokens[1]!r} must be a literal subcommand "
                "(no `*`, no leading `-`, so `git -c` / `git -C` cannot be granted)"
            )
        for i, tok in enumerate(tokens):
            if "*" in tok:
                if tok != "*" or i != last:
                    out.append(f"{entry!r}: wildcard must be the final bare `*` token, got {tok!r} at word {i}")
            elif not _PLAIN_TOKEN_RE.match(tok):
                out.append(f"{entry!r}: word {tok!r} is not a plain word/option (empty, shell metacharacter, ...)")
        if tokens[0] == "gh" and (len(tokens) < 3 or tokens[2] == "*" or tokens[2].startswith("-")):
            out.append(
                f"{entry!r}: gh rules must name a literal `<group> <action>` "
                "(a bare group wildcard such as `gh pr *` would include `pr merge`)"
            )
    return out


def forbidden_subcommand_violations(allow):
    out = []
    for entry, tokens in _git_gh_entries(allow):
        if len(tokens) < 2:
            continue
        sub = tokens[1]
        if tokens[0] == "git" and sub in FORBIDDEN_GIT_SUBCOMMANDS:
            out.append(f"{entry!r} grants forbidden git subcommand {sub!r}")
        if tokens[0] == "gh":
            if sub in FORBIDDEN_GH_GROUPS:
                out.append(f"{entry!r} grants forbidden gh group {sub!r}")
            action = tokens[2] if len(tokens) > 2 else None
            if action in FORBIDDEN_GH_ACTIONS.get(sub, ()):
                out.append(f"{entry!r} grants forbidden gh action `{sub} {action}`")
    return out


def remote_anchor_violations(allow):
    """git push/fetch/pull must be bare or anchored on `origin`."""
    out = []
    for entry, tokens in _git_gh_entries(allow):
        if tokens[0] != "git" or len(tokens) < 2 or tokens[1] not in REMOTE_SUBCOMMANDS:
            continue
        sub, rest = tokens[1], tokens[2:]
        anchored = (
            rest == []
            or rest[0] == "origin"
            or (sub == "push" and rest[:2] == ["-u", "origin"])
        )
        if not anchored:
            out.append(
                f"{entry!r}: `git {sub}` must be bare or anchored on `origin` "
                "so a URL / other remote cannot ride on the grant"
            )
    return out


def _load_fragment():
    def no_duplicate_keys(pairs):
        keys = [k for k, _ in pairs]
        dup = {k for k in keys if keys.count(k) > 1}
        if dup:
            raise ValueError(f"duplicate JSON keys: {sorted(dup)}")
        return dict(pairs)

    with open(FRAGMENT_PATH, encoding="utf-8") as f:
        return json.load(f, object_pairs_hook=no_duplicate_keys)


class FragmentTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fragment = _load_fragment()
        cls.allow = cls.fragment["permissions"]["allow"]
        cls.deny = cls.fragment["permissions"].get("deny", [])


class TestAllowShape(FragmentTestBase):
    def test_allow_is_list_of_unique_strings(self):
        self.assertIsInstance(self.allow, list, "permissions.allow must be a list")
        for entry in self.allow:
            self.assertIsInstance(entry, str, f"non-string allow entry: {entry!r}")
        dupes = sorted({e for e in self.allow if self.allow.count(e) > 1})
        self.assertEqual([], dupes, f"duplicate allow entries: {dupes}")

    def test_deny_is_list_of_unique_strings(self):
        self.assertIsInstance(self.deny, list, "permissions.deny must be a list")
        for entry in self.deny:
            self.assertIsInstance(entry, str, f"non-string deny entry: {entry!r}")
        dupes = sorted({e for e in self.deny if self.deny.count(e) > 1})
        self.assertEqual([], dupes, f"duplicate deny entries: {dupes}")


class TestAllowExactSet(FragmentTestBase):
    """Change detector: see EXPECTED_ALLOW and the README permissions section."""

    def test_allow_equals_expected_set(self):
        unexpected, missing = exact_set_diff(self.allow)
        self.assertEqual(
            ([], []),
            (unexpected, missing),
            "permissions.allow changed. If intended, update EXPECTED_ALLOW in this test and the "
            "README section 「権限 (`permissions.allow`) の方針」 in the same change.\n"
            f"  unexpected (in fragment, not expected): {unexpected}\n"
            f"  missing (expected, not in fragment): {missing}",
        )


class TestDenyExactSet(FragmentTestBase):
    """Change detector for permissions.deny: see EXPECTED_DENY."""

    def test_retired_curl_deny_entries_are_gone_and_listed_for_removal(self):
        import install  # the pack definition (repo root); importing it runs nothing
        for entry in RETIRED_CURL_DENY_ENTRIES:
            with self.subTest(entry=entry):
                self.assertNotIn(entry, self.deny)
        self.assertEqual(sorted(RETIRED_CURL_DENY_ENTRIES), sorted(install.PACK.retired_deny))

    def test_deny_equals_expected_set(self):
        unexpected, missing = deny_set_diff(self.deny)
        self.assertEqual(
            ([], []),
            (unexpected, missing),
            "permissions.deny changed. If intended, update EXPECTED_DENY in this test and the "
            "README section 「権限 (`permissions.allow`) の方針」 in the same change.\n"
            f"  unexpected (in fragment, not expected): {unexpected}\n"
            f"  missing (expected, not in fragment): {missing}",
        )


class TestAllowInvariants(FragmentTestBase):
    """Independent of EXPECTED_ALLOW: must hold for any future allow list."""

    def assertNoViolations(self, violations, hint):
        self.assertEqual([], violations, hint + "\n  " + "\n  ".join(violations))

    def test_no_blanket_grants(self):
        self.assertNoViolations(blanket_violations(self.allow), "blanket grant present")

    def test_only_git_gh_and_curl_tools(self):
        self.assertNoViolations(tool_violations(self.allow), "disallowed tool granted")

    def test_curl_is_never_granted(self):
        self.assertNoViolations(curl_violations(self.allow), "curl grant differs from policy")

    def test_literal_subcommand_and_final_wildcard_only(self):
        self.assertNoViolations(shape_violations(self.allow), "rule shape violates policy")

    def test_no_forbidden_subcommands(self):
        self.assertNoViolations(
            forbidden_subcommand_violations(self.allow), "forbidden subcommand granted"
        )

    def test_remote_operations_bare_or_origin_anchored(self):
        self.assertNoViolations(
            remote_anchor_violations(self.allow), "unanchored remote operation granted"
        )



class TestCurlPatterns(FragmentTestBase):
    """curl is neither granted nor denied by the pack; the allow entries are checked as pattern text only.

    fnmatch is an approximation of Claude Code's matcher (see rule_matches); a
    pass here is a sanity check of the pattern text, not proof of runtime behaviour.
    """

    def test_no_allow_rule_matches_any_curl_command(self):
        for command in DEPLOY_RUNNER_CURL_COMMANDS + (
            "curl https://example.invalid/",
            "curl -sS --max-time 10 -o ~/.zshrc -w '%{http_code}' https://example.invalid/",
            "curl -sS --max-time 10 -o /tmp/b -o ~/.zshrc -w x https://example.invalid/",
        ):
            with self.subTest(command=command):
                self.assertFalse(any(rule_matches(e, command) for e in self.allow))

    def test_retired_entries_are_not_granted_and_are_listed_for_removal(self):
        import install  # the pack definition (repo root); importing it runs nothing
        for entry in RETIRED_CURL_ENTRIES:
            with self.subTest(entry=entry):
                self.assertNotIn(entry, self.allow)
        self.assertEqual(set(RETIRED_CURL_ENTRIES), set(install.PACK.retired_allow))

    def test_no_deny_rule_matches_any_curl_command(self):
        # The pack no longer bans any curl form: legitimate uses (-X POST, -H "Authorization: ...",
        # $(...) in a header) run after the normal prompt / classifier.
        for command in DEPLOY_RUNNER_CURL_COMMANDS + (
            "curl -X POST -H 'Authorization: Bearer $(gh auth token)' https://api.example.invalid/",
            "curl -sS -d @payload.json https://example.invalid/",
        ):
            with self.subTest(command=command):
                self.assertFalse(any(rule_matches(e, command) for e in self.deny))


class TestHooksWiring(FragmentTestBase):
    """Narrowing `allow` must never drop the hook layer that backs it."""

    EXPECTED_HOOKS = {
        "Bash": [
            "git-destructive-blocker.py",
            "pr-base-checker.py",
            "commit-msg-convention.py",
        ],
        "Edit|Write|MultiEdit": ["protected-branch-edit-guard.py"],
    }

    def _commands_for(self, matcher):
        entries = self.fragment["hooks"]["PreToolUse"]
        cmds = []
        for entry in entries:
            if entry.get("matcher") == matcher:
                for hook in entry.get("hooks", []):
                    self.assertEqual("command", hook.get("type"), f"{matcher}: hook type")
                    cmds.append(hook.get("command", ""))
        return cmds

    def test_pretooluse_matchers_wire_expected_hooks(self):
        for matcher, scripts in self.EXPECTED_HOOKS.items():
            cmds = self._commands_for(matcher)
            self.assertTrue(cmds, f"PreToolUse matcher {matcher!r} is missing")
            for script in scripts:
                self.assertTrue(
                    any(c.split()[-1].endswith("/hooks/" + script) for c in cmds if c.split()),
                    f"matcher {matcher!r} no longer runs hooks/{script}; commands: {cmds}",
                )


class TestCheckersBite(unittest.TestCase):
    """The checkers must reject known-bad input, otherwise the suite is vacuous."""

    GOOD = sorted(EXPECTED_ALLOW)

    def assertFlagged(self, checker, bad_entries):
        for bad in bad_entries:
            with self.subTest(entry=bad):
                self.assertTrue(
                    checker(self.GOOD + [bad]),
                    f"{checker.__name__} did not flag {bad!r}",
                )

    GOOD_DENY = sorted(EXPECTED_DENY)

    def test_expected_set_is_clean_under_every_checker(self):
        for checker in (
            blanket_violations, tool_violations, curl_violations, shape_violations,
            forbidden_subcommand_violations, remote_anchor_violations,
        ):
            with self.subTest(checker=checker.__name__):
                self.assertEqual([], checker(self.GOOD))

    def test_exact_deny_set_flags_any_change(self):
        self.assertNotEqual(([], []), deny_set_diff(self.GOOD_DENY + ["Bash(curl * -o*)"]))
        for entry in RETIRED_CURL_DENY_ENTRIES:
            with self.subTest(entry=entry):
                self.assertNotEqual(([], []), deny_set_diff([entry]))
        self.assertEqual(([], []), deny_set_diff(self.GOOD_DENY))

    def test_exact_set_flags_any_change(self):
        self.assertNotEqual(([], []), exact_set_diff(self.GOOD + ["Bash(git *)"]))
        self.assertNotEqual(([], []), exact_set_diff(self.GOOD[1:]))

    def test_blanket_flagged(self):
        self.assertFlagged(blanket_violations, sorted(BLANKET_FORMS))

    def test_tools_flagged(self):
        self.assertFlagged(
            tool_violations,
            ["Bash(claude *)", "Bash(wget *)", "Bash(sh *)", "Bash(bash *)",
             "Bash(python3 *)", "Bash(node *)", "Bash(npx *)", "Bash(rm *)", "Bash(*)",
             "Read(*)", "Bash", "Bash(curl:*)"],
        )

    def test_any_curl_form_flagged(self):
        self.assertFlagged(
            curl_violations,
            list(RETIRED_CURL_ENTRIES)
            + ["Bash(curl *)", "Bash(curl)", "Bash(curl -d *)", "Bash(curl -T *)",
               "Bash(curl -sS *)", "Bash(curl -sS -o *)", "Bash(curl -sS -o * -w)",
               "Bash(curl -sS -o * -w *)",
               "Bash(curl -sS --max-time * -o /tmp/* -w *)",  # a /tmp/-pinned form is still widenable
               "Bash(curl -sS --max-time * -o * -w * -X POST)",
               "Bash(curl https://example.invalid/*)", "Bash(curl * | sh)", "Bash(curl:*)"],
        )

    def test_shape_flagged(self):
        self.assertFlagged(
            shape_violations,
            ["Bash(git *)", "Bash(gh *)", "Bash(git)", "Bash(git -c *)", "Bash(git -C *)",
             "Bash(git * status)", "Bash(git status:*)", "Bash(git status * foo)",
             "Bash(git  status *)", "Bash(git status; curl x)", "Bash(gh pr *)",
             "Bash(gh * list)", "Bash(gh)"],
        )

    def test_forbidden_subcommands_flagged(self):
        self.assertFlagged(
            forbidden_subcommand_violations,
            ["Bash(git config *)", "Bash(git remote *)", "Bash(git reset *)", "Bash(git clean *)",
             "Bash(git rebase *)", "Bash(git stash *)", "Bash(git tag *)", "Bash(git am *)",
             "Bash(gh api *)", "Bash(gh auth token)", "Bash(gh alias set *)",
             "Bash(gh extension install *)", "Bash(gh repo delete *)", "Bash(gh workflow run *)",
             "Bash(gh pr merge *)", "Bash(gh pr comment *)", "Bash(gh issue create *)",
             "Bash(gh issue close *)", "Bash(gh run rerun *)", "Bash(gh run cancel *)"],
        )

    def test_remote_anchor_flagged(self):
        self.assertFlagged(
            remote_anchor_violations,
            ["Bash(git push *)", "Bash(git push --force *)", "Bash(git push https://example.invalid/x.git *)",
             "Bash(git fetch *)", "Bash(git fetch --upload-pack=x *)", "Bash(git pull *)",
             "Bash(git pull -u origin *)"],
        )


if __name__ == "__main__":
    unittest.main()
