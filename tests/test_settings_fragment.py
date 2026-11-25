#!/usr/bin/env python3
"""stdlib-only unittest suite for settings-fragment.json.

Guards the permissions-hardening of ``permissions.allow`` / ``permissions.deny``:
the pack grants only the git / gh operations it really uses, never a blanket
``Bash(git *)`` and the like. The only other grants are the two narrow curl forms
that agents/deploy-runner.md needs for its post-publish verification (pages:
``curl -sS --max-time N -o /tmp/<body file> -w '%{http_code}' <url>``; assets, HEAD:
``curl -sS --head --max-time N -o /dev/null -w '%{http_code} %{content_type}' <url>``),
paired with deny entries for write-ish curl flags (deny beats allow). Policy and rationale: README section
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

# The only curl grants the pack keeps: the two deploy-runner verification forms,
# restricted to reads by the deny entries below (explicit owner decision).
# Pages: GET into a body file under /tmp/. Assets: HEAD, with `-o /dev/null` pinned.
CURL_PAGE_ENTRY = "Bash(curl -sS --max-time * -o /tmp/* -w *)"
CURL_HEAD_ENTRY = "Bash(curl -sS --head --max-time * -o /dev/null -w *)"
CURL_ENTRIES = (CURL_PAGE_ENTRY, CURL_HEAD_ENTRY)

# The documented deploy-runner commands (agents/deploy-runner.md, verification step)
# with the placeholders filled in, keyed by the allow entry that must cover each.
# Mirrored here on purpose rather than read from that file, so an edit of the agent
# doc cannot silently weaken or break this suite; if the documented forms change,
# update these constants and the two entries together.
DEPLOY_RUNNER_CURL_COMMANDS = {
    CURL_PAGE_ENTRY: (
        "curl -sS --max-time 10 -o /tmp/body.txt -w '%{http_code}' https://example.invalid/health"
    ),
    CURL_HEAD_ENTRY: (
        "curl -sS --head --max-time 5 -o /dev/null -w '%{http_code} %{content_type}' "
        "https://example.invalid/app.js"
    ),
}

# curl flags that upload / send a body, change the method, or load a config file.
# Each must have a deny entry `Bash(curl * <flag>*)` (the space before the flag is
# deliberate so the deny only fires on a flag word, not inside a path).
REQUIRED_DENY_FLAGS = (
    "-d", "--data", "--json", "-F", "--form", "-T", "--upload-file",
    "-X", "--request", "-K", "--config",
)

# Substrings that let a curl command send local file content or escape the /tmp/ prefix:
# `@` (-H @file, --url-query @file, --variable x@file), command substitution ($( and a
# backtick) and `..`. Each must have a deny entry `Bash(curl *<s>*)` (no space: they can
# sit inside a word, e.g. `x@file`).
REQUIRED_DENY_SUBSTRINGS = ("@", "$(", "`", "..")

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
        # curl: only the two deploy-runner verification forms (see README)
        CURL_PAGE_ENTRY,
        CURL_HEAD_ENTRY,
    }
)

# CHANGE DETECTOR for permissions.deny -- same rule as EXPECTED_ALLOW.
EXPECTED_DENY = frozenset(
    {
        "Bash(curl * -d*)",
        "Bash(curl * --data*)",
        "Bash(curl * --json*)",
        "Bash(curl * -F*)",
        "Bash(curl * --form*)",
        "Bash(curl * -T*)",
        "Bash(curl * --upload-file*)",
        "Bash(curl * -X*)",
        "Bash(curl * --request*)",
        "Bash(curl * -K*)",
        "Bash(curl * --config*)",
        "Bash(curl *@*)",
        "Bash(curl *$(*)",
        "Bash(curl *`*)",
        "Bash(curl *..*)",
    }
)

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

# curl is allowed, but only as the two narrow CURL_ENTRIES (see curl_violations).
ALLOWED_TOOLS = GIT_GH_TOOLS | {"curl"}

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
            out.append(f"{entry!r} is not a Bash(...) rule; the pack grants git/gh/curl via Bash only")
        elif tokens[0] in FORBIDDEN_TOOLS:
            out.append(f"{entry!r} grants the forbidden tool {tokens[0]!r}")
        elif tokens[0] not in ALLOWED_TOOLS:
            out.append(f"{entry!r} grants tool {tokens[0]!r}; only git / gh / curl are allowed")
    return out


def curl_violations(allow):
    """curl must be granted as exactly the entries in CURL_ENTRIES, each once, and
    no other form.

    Broad forms (`curl *`, the legacy `curl:*`, `curl -d *`, a bare `curl`, a
    URL-anchored pattern, the old `curl -sS -o * -w *`) are rejected: the pack
    grants only the two read-only deploy-runner verification forms. Entries are
    matched on the first word of the spec, including the legacy ``curl:*`` prefix
    spelling.
    """
    out = []
    seen = {entry: 0 for entry in CURL_ENTRIES}
    for entry in allow:
        tokens = _parse_bash(entry)
        if tokens is None:
            continue
        if tokens[0] == "curl" or tokens[0].startswith("curl:"):
            if entry in seen:
                seen[entry] += 1
            else:
                out.append(f"{entry!r} is a curl form outside {list(CURL_ENTRIES)!r}")
    for entry, count in seen.items():
        if count == 0:
            out.append(f"{entry!r} is missing (the deploy-runner verification needs it)")
        elif count > 1:
            out.append(f"{entry!r} appears {count} times")
    return out


def deny_violations(deny):
    """Every deny entry must be a `Bash(curl ...)` rule, and every write-ish curl
    flag in REQUIRED_DENY_FLAGS must be covered by `Bash(curl * <flag>*)`."""
    out = []
    for entry in deny:
        if not isinstance(entry, str) or not entry.startswith("Bash(curl ") or not entry.endswith(")"):
            out.append(f"{entry!r} is not a `Bash(curl ...)` rule; permissions.deny is for write-ish curl forms only")
    present = {e for e in deny if isinstance(e, str)}
    for flag in REQUIRED_DENY_FLAGS:
        required = f"Bash(curl * {flag}*)"
        if required not in present:
            out.append(f"{required!r} is missing: write-ish curl flag {flag!r} is not denied")
    for sub in REQUIRED_DENY_SUBSTRINGS:
        required = f"Bash(curl *{sub}*)"
        if required not in present:
            out.append(f"{required!r} is missing: curl substring {sub!r} (file read / path escape) is not denied")
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
        cls.deny = cls.fragment["permissions"]["deny"]


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

    def test_curl_is_exactly_the_two_deploy_runner_entries(self):
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

    def test_deny_entries_are_curl_only_and_cover_write_flags(self):
        self.assertNoViolations(deny_violations(self.deny), "permissions.deny violates policy")


class TestCurlPatterns(FragmentTestBase):
    """The allowed curl forms and the deny entries, checked as pattern text only.

    fnmatch is an approximation of Claude Code's matcher (see rule_matches); a
    pass here is a sanity check of the pattern text, not proof of runtime behaviour.
    """

    WRITE_ISH_EXTRAS = [
        "-d @secret", "-dfoo", "--data @secret", "--data-binary @secret",
        "--data-urlencode a@secret", "--json @secret", "-F a=@secret", "--form a=@secret",
        "-T secret", "--upload-file secret", "-X POST", "-XPOST", "--request POST",
        "-K cfg", "--config cfg",
        # local file content sent as a header / query / variable / command substitution
        "-H @/path/.env", "--header @/path/.env", "--url-query @file", "--variable x@file",
        "-H x:$(cat file)", "-H x:`cat file`", "--url-query ../file",
    ]

    def _denied(self, command):
        return [d for d in self.deny if rule_matches(d, command)]

    def test_documented_commands_are_allowed_and_not_denied(self):
        for entry, command in DEPLOY_RUNNER_CURL_COMMANDS.items():
            with self.subTest(command=command):
                self.assertTrue(
                    rule_matches(entry, command),
                    f"documented deploy-runner command {command!r} no longer matches {entry!r}",
                )
                self.assertIn(entry, self.allow)
                self.assertEqual([], self._denied(command))

    def test_each_documented_command_needs_its_own_entry(self):
        # `--max-time` sits at a different position in the two forms, so neither
        # entry covers the other form; both entries are required.
        self.assertFalse(rule_matches(CURL_HEAD_ENTRY, DEPLOY_RUNNER_CURL_COMMANDS[CURL_PAGE_ENTRY]))
        self.assertFalse(rule_matches(CURL_PAGE_ENTRY, DEPLOY_RUNNER_CURL_COMMANDS[CURL_HEAD_ENTRY]))

    def test_write_ish_variants_of_each_allowed_form_are_denied(self):
        for entry, base in DEPLOY_RUNNER_CURL_COMMANDS.items():
            for extra in self.WRITE_ISH_EXTRAS:
                command = f"{base} {extra}"
                with self.subTest(entry=entry, extra=extra):
                    self.assertTrue(rule_matches(entry, command), f"{command!r} should reach the allow rule")
                    self.assertTrue(self._denied(command), f"{command!r} matches allow but no deny entry")

    def test_page_body_file_is_pinned_under_tmp_and_cannot_escape(self):
        base = "curl -sS --max-time 10 -o {} -w '%{{http_code}}' https://example.invalid/health"
        self.assertTrue(rule_matches(CURL_PAGE_ENTRY, base.format("/tmp/body.txt")))
        for out in ("~/.zshrc", "$HOME/.zshrc", "/Users/x/.zshrc", ".claude/settings.json", "body.txt"):
            with self.subTest(out=out):
                self.assertFalse(rule_matches(CURL_PAGE_ENTRY, base.format(out)))
        # `..` can reach the prefix but is denied
        escaped = base.format("/tmp/../etc/x")
        self.assertTrue(rule_matches(CURL_PAGE_ENTRY, escaped))
        self.assertTrue(self._denied(escaped))

    def test_other_curl_commands_are_not_allowed(self):
        for command in (
            "curl https://example.invalid/",
            "curl -d @secret https://example.invalid/",
            "curl -sS https://example.invalid/",
            # the previous single form, without --max-time
            "curl -sS -o /tmp/x -w '%{http_code}' https://example.invalid/",
            "curl -o /tmp/x -w '%{http_code}' https://example.invalid/",
            # HEAD form without --max-time, or with -o not pinned to /dev/null
            "curl -sS --head -o /dev/null -w '%{http_code}' https://example.invalid/",
            "curl -sS --head --max-time 5 -o /tmp/x -w '%{http_code}' https://example.invalid/",
            # the old page form let -o write anywhere
            "curl -sS --max-time 10 -o ~/.zshrc -w '%{http_code}' https://example.invalid/",
        ):
            with self.subTest(command=command):
                self.assertFalse(any(rule_matches(e, command) for e in CURL_ENTRIES))


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
        self.assertEqual([], deny_violations(self.GOOD_DENY))

    def test_exact_deny_set_flags_any_change(self):
        self.assertNotEqual(([], []), deny_set_diff(self.GOOD_DENY + ["Bash(curl * -o*)"]))
        self.assertNotEqual(([], []), deny_set_diff(self.GOOD_DENY[1:]))
        self.assertEqual(([], []), deny_set_diff(self.GOOD_DENY))

    def test_deny_missing_entry_flagged(self):
        for missing in self.GOOD_DENY:
            with self.subTest(missing=missing):
                self.assertTrue(
                    deny_violations([e for e in self.GOOD_DENY if e != missing]),
                    f"deny_violations did not flag missing {missing!r}",
                )
        self.assertTrue(deny_violations([]), "empty deny list was not flagged")

    def test_deny_non_curl_or_malformed_entry_flagged(self):
        for bad in ("Bash(rm *)", "Bash(git push *)", "Read(*)", "Bash(curl", "curl * -d*", 3):
            with self.subTest(entry=bad):
                self.assertTrue(
                    deny_violations(self.GOOD_DENY + [bad]),
                    f"deny_violations did not flag {bad!r}",
                )

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

    def test_curl_extra_forms_flagged(self):
        self.assertFlagged(
            curl_violations,
            ["Bash(curl *)", "Bash(curl)", "Bash(curl -d *)", "Bash(curl -T *)",
             "Bash(curl -sS *)", "Bash(curl -sS -o *)", "Bash(curl -sS -o * -w)",
             "Bash(curl -sS -o * -w *)",  # the previous single form, no --max-time
             "Bash(curl -sS --max-time * -o * -w *)",  # the previous page form, -o not pinned to /tmp/
             "Bash(curl -sS --max-time * -o * -w * -X POST)",
             "Bash(curl -sS --head --max-time * -o * -w *)",  # -o not pinned to /dev/null
             "Bash(curl -sS --head * -o /dev/null -w *)",
             "Bash(curl https://example.invalid/*)", "Bash(curl * | sh)", "Bash(curl:*)"],
        )

    def test_curl_missing_or_duplicated_flagged(self):
        for entry in CURL_ENTRIES:
            with self.subTest(entry=entry):
                without = [e for e in self.GOOD if e != entry]
                self.assertTrue(curl_violations(without), f"missing {entry!r} was not flagged")
                self.assertTrue(
                    curl_violations(self.GOOD + [entry]), f"duplicated {entry!r} was not flagged"
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
