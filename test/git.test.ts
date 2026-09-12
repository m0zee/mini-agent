import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runGit, validateGitArgs } from "../src/tools/git.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// A literal timeout is impractical to test for real: it would need a git
// invocation that legitimately runs for 15+ seconds, which would make this
// suite slow and flaky for no real coverage gain (the timeout branch in
// git.ts is a straight pass-through of execFile's own documented
// `error.killed` behavior). Deliberately not tested, per the task's own
// "do not over-engineer this" guidance.

// The real-git-spawn tests below guard themselves with this check and skip
// (rather than fail) when git is not runnable in the sandbox.
function isGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

// --- validateGitArgs: accepted (no spawn) ---------------------------------

test("validateGitArgs accepts log --oneline -n 5", () => {
  assert.deepEqual(validateGitArgs(["log", "--oneline", "-n", "5"]), { ok: true });
});

test("validateGitArgs accepts log --since=... --pretty=format:%s", () => {
  assert.deepEqual(validateGitArgs(["log", "--since=2 weeks ago", "--pretty=format:%s"]), { ok: true });
});

test("validateGitArgs accepts describe --tags", () => {
  assert.deepEqual(validateGitArgs(["describe", "--tags"]), { ok: true });
});

// --- validateGitArgs: rejected, per the spec's exact list (no spawn) -----

test("validateGitArgs rejects push (subcommand not allowed)", () => {
  const result = validateGitArgs(["push", "origin", "main"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects a global -c option before the subcommand", () => {
  const result = validateGitArgs(["-c", "core.pager=calc", "log"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --exec=x", () => {
  const result = validateGitArgs(["log", "--exec=x"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --output=x", () => {
  const result = validateGitArgs(["log", "--output=x"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --git-dir=..", () => {
  const result = validateGitArgs(["log", "--git-dir=.."]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log -o x", () => {
  const result = validateGitArgs(["log", "-o", "x"]);
  assert.equal(result.ok, false);
});

// --- validateGitArgs: the remaining exec-adjacent flags from the spec ----

test("validateGitArgs rejects log --work-tree=/", () => {
  const result = validateGitArgs(["log", "--work-tree=/"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --upload-pack=calc", () => {
  const result = validateGitArgs(["log", "--upload-pack=calc"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --receive-pack=calc", () => {
  const result = validateGitArgs(["log", "--receive-pack=calc"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects log --config=x", () => {
  const result = validateGitArgs(["log", "--config=x"]);
  assert.equal(result.ok, false);
});

test('validateGitArgs rejects the bare "--" pathspec separator (fail-closed: not on any allowlist)', () => {
  const result = validateGitArgs(["log", "--"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects diff --no-index (an arbitrary-file-read vector, not on the flag allowlist)", () => {
  const result = validateGitArgs(["diff", "--no-index"]);
  assert.equal(result.ok, false);
});

// --- validateGitArgs: branch/tag creation must require --list -------------
//
// branch/tag are unique among the ten allowed subcommands: a bare
// positional argument to either is not a filter to read, it is the name of
// a ref to CREATE. Delete/move flags (-d/-D/-m/-f) are already rejected by
// the flag allowlist, but plain creation takes no special flag at all, so
// this needed a dedicated check in validateGitArgs.

test("validateGitArgs rejects branch <name> because a bare positional argument would CREATE a ref", () => {
  const result = validateGitArgs(["branch", "evil"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects tag <name> because a bare positional argument would CREATE a ref", () => {
  const result = validateGitArgs(["tag", "v9"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs still accepts branch --list <pattern> (regression guard: listing must keep working)", () => {
  assert.deepEqual(validateGitArgs(["branch", "--list", "rel-*"]), { ok: true });
});

test("validateGitArgs still accepts tag --list (regression guard: listing must keep working)", () => {
  assert.deepEqual(validateGitArgs(["tag", "--list"]), { ok: true });
});

test("validateGitArgs still accepts a bare branch (no positional args at all, lists local branches)", () => {
  assert.deepEqual(validateGitArgs(["branch"]), { ok: true });
});

// --- validateGitArgs: additional cases beyond the spec's minimum ---------

test("validateGitArgs rejects an empty args array", () => {
  const result = validateGitArgs([]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects a flag as args[0] instead of a subcommand", () => {
  const result = validateGitArgs(["--version"]);
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects a non-array args value without spawning", () => {
  const result = validateGitArgs("log --oneline");
  assert.equal(result.ok, false);
});

test("validateGitArgs rejects an array containing a non-string element without spawning", () => {
  const result = validateGitArgs(["log", 5]);
  assert.equal(result.ok, false);
});

// --- runGit: validation failures reject before spawning -------------------

test("runGit rejects a validation failure (push) with a short reason, without needing git installed", async () => {
  await assert.rejects(() => runGit(["push", "origin", "main"], REPO_ROOT), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /push/);
    return true;
  });
});

test("runGit rejects malformed args (a plain string instead of an array) without spawning", async () => {
  await assert.rejects(() => runGit("log", REPO_ROOT));
});

test("runGit rejects args containing a non-string element without spawning", async () => {
  await assert.rejects(() => runGit(["log", 5], REPO_ROOT));
});

// --- runGit: real git spawn (skipped if git is unavailable) ---------------

test("runGit actually runs git log against this repo and returns real commit history", async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }

  const result = await runGit(["log", "--oneline", "-n", "1"], REPO_ROOT);
  assert.ok(result.startsWith("exit=0"), `expected output to start with "exit=0", got: ${result}`);

  const lines = result.split("\n");
  assert.ok(lines.length >= 2, "expected at least an exit line and a commit line");
  assert.ok(lines[1].trim().length > 0, "expected a non-empty --oneline commit line");
});

test("runGit strips real ANSI escape codes and control bytes that git itself emits, not just a hand-built string", async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }

  // --pretty= is prefix-allowed by the flag allowlist, and its value can
  // make git emit genuine ANSI color codes (%C(always,red)/%C(reset), the
  // "always" forcing color even with no attached TTY) plus raw control
  // bytes (%x1b = ESC, %x00 = NUL, %x07 = BEL) into stdout. This proves
  // sanitizeForTerminal runs on the real bytes git actually produced, not
  // just on a string this module happened to construct itself. Confirmed
  // against this repo's real git: the raw (unsanitized) child_process
  // output contains a literal ESC/NUL/BEL and an ANSI color escape; the
  // tool's actual returned string does not.
  const result = await runGit(
    ["log", "--pretty=format:%C(always,red)RED%C(reset)%x1b[31mESC%x00NUL%x07BEL", "-n", "1"],
    REPO_ROOT,
  );

  // Exact equality is the real proof: if any raw ESC/NUL/BEL byte or an
  // unstripped ANSI color code had survived, this would not match.
  assert.equal(result, "exit=0\nREDESCNULBEL\n");
  assert.ok(!result.includes("\u001b"), "expected no raw ESC byte to survive");
  assert.ok(!result.includes("\u0000"), "expected no raw NUL byte to survive");
  assert.ok(!result.includes("\u0007"), "expected no raw BEL byte to survive");
});

test("runGit caps real (uncapped, tens of KB) git output at exactly 20480 bytes with a truncation note", async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }

  // A --pretty= format repeated across every commit in this repo's history
  // produces output far larger than the 20 KB cap (each commit contributes
  // a 4000-byte line), so this exercises capOutput against real execFile
  // output rather than a hand-built string.
  const result = await runGit(["log", "--pretty=format:" + "A".repeat(4000)], REPO_ROOT);

  assert.equal(Buffer.byteLength(result, "utf8"), 20480);
  assert.ok(result.endsWith("\n...(truncated at 20 KB)"));
});

test("runGit rejects with a non-zero exit code and a not-a-git-repository message for a non-repo cwd", async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }

  const notARepo = await mkdtemp(path.join(tmpdir(), "mini-agent-git-notrepo-"));
  try {
    await assert.rejects(() => runGit(["status"], notARepo), (err: unknown) => {
      assert.ok(err instanceof Error);
      const match = err.message.match(/^exit=(\d+)/);
      assert.ok(match, `expected message to start with "exit=<code>", got: ${err.message}`);
      assert.notEqual(Number(match[1]), 0);
      assert.match(err.message.toLowerCase(), /not a git repository/);
      return true;
    });
  } finally {
    await rm(notARepo, { recursive: true, force: true });
  }
});
