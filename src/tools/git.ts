import { execFile } from "node:child_process";
import { sanitizeForTerminal } from "../text.js";

// Read-only subcommands only (plan.md §7 T5): args[0] must be exactly one of
// these, never a global option (e.g. "-c", "--exec") ahead of it — a global
// option before the subcommand is exactly how git itself can be turned into
// an execution vector (custom pager/editor, arbitrary config, hooks).
const ALLOWED_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "tag",
  "describe",
  "rev-parse",
  "shortlog",
  "branch",
  "ls-files",
]);

// Exact flag strings allowed anywhere after the subcommand.
const ALLOWED_FLAGS = new Set([
  "--oneline",
  "--stat",
  "--name-only",
  "--name-status",
  "--no-merges",
  "--reverse",
  "--decorate",
  "--abbrev-commit",
  "--list",
  "--tags",
  "--all",
  "--short",
  "--porcelain",
  "--cached",
  "-n",
]);

// "--key=value" flags: any arg starting with one of these prefixes is
// allowed regardless of its value (the value itself is not a flag).
const ALLOWED_FLAG_PREFIXES = [
  "--max-count=",
  "--since=",
  "--until=",
  "--after=",
  "--before=",
  "--author=",
  "--pretty=",
  "--format=",
  "--date=",
];

// "branch" and "tag" are unique among the ten allowed subcommands: a bare
// positional argument to either of them is not a filter/pattern to read —
// it is the name of a ref to CREATE (`git branch <name>` / `git tag
// <name>`), a write despite every argument involved passing the flag
// allowlist (delete/move flags like -d/-D/-m/-f are already rejected there,
// but plain creation takes no flag at all). Require --list before allowing
// any positional argument to either subcommand, which keeps every other
// read-only usage (bare "branch"/"tag" to list, or "--list <pattern>")
// working while closing the write path.
const LIST_ONLY_SUBCOMMANDS = new Set(["branch", "tag"]);

// Only these env vars are ever copied from the parent process; everything
// else the child sees is one of the fixed values below. This is a
// deliberate allowlist, not a denylist (plan.md §7 T5): the full
// process.env is never handed to the child, which is what stops an
// ANTHROPIC_API_KEY or any other secret sitting in this process's
// environment from leaking into a spawned git process.
const INHERITED_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SystemRoot"] as const;

const TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 1_000_000;

// 20 KB, spec-mandated cap on the whole formatted "exit=…\n…\n…" string.
// Measured in UTF-8 bytes (not JS string length / UTF-16 code units)
// because git output can contain non-ASCII commit messages, and the
// documented budget is a byte budget.
const MAX_OUTPUT_BYTES = 20 * 1024;
const TRUNCATION_NOTE = "\n...(truncated at 20 KB)";

export type GitArgsValidation = { ok: true } | { ok: false; reason: string };

/**
 * Pure runtime validator for the git tool's `args`: callable — and always
 * called by the test suite for rejection cases — without ever spawning a
 * process. Enforces, in order:
 *
 *  1. `args` is an array and every element is a string (rule 1). Anything
 *     else (not an array at all, or one non-string element anywhere in it)
 *     is rejected here before any of the checks below ever run.
 *  2. `args[0]` is exactly one of the allow-listed read-only subcommands
 *     (rule 2) — never a global option, so a request like
 *     `["-c", "core.pager=calc", "log"]` is rejected on its very first
 *     element, not on "-c" happening to also fail the flag check below.
 *  3. Every remaining argument that starts with "-" is either an exact
 *     allow-listed flag or starts with an allow-listed "--key=" prefix
 *     (rule 3). This explicitly catches "-c", "--exec", "--output", "-o",
 *     "--git-dir", "--work-tree", "--upload-pack", "--receive-pack", and
 *     "--config" — none of them appear in either allowlist, so they all
 *     fall through to the rejection at the end of the loop. An argument
 *     that does not start with "-" (a branch/tag name, a path, the value
 *     following "-n") is a positional argument and is never checked here
 *     — EXCEPT for "branch"/"tag" per the next rule.
 *  4. For "branch" and "tag" specifically, a positional argument is not a
 *     value to read but the name of a ref to CREATE — a write, despite
 *     needing no special flag — so it is rejected unless "--list" is also
 *     present. This is not part of the general flag allowlist above
 *     because it depends on the subcommand, not on the argument itself.
 */
export function validateGitArgs(args: unknown): GitArgsValidation {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return { ok: false, reason: "args must be an array of strings" };
  }

  const [subcommand, ...rest] = args as string[];
  if (subcommand === undefined) {
    return { ok: false, reason: "args must start with a subcommand" };
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, reason: `subcommand "${subcommand}" is not allowed` };
  }

  if (LIST_ONLY_SUBCOMMANDS.has(subcommand) && !rest.includes("--list")) {
    const positional = rest.find((arg) => !arg.startsWith("-"));
    if (positional !== undefined) {
      return { ok: false, reason: `"git ${subcommand} ${positional}" would create a ref; use --list` };
    }
  }

  for (const arg of rest) {
    if (!arg.startsWith("-")) {
      continue;
    }
    if (ALLOWED_FLAGS.has(arg)) {
      continue;
    }
    if (ALLOWED_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    return { ok: false, reason: `flag "${arg}" is not allowed` };
  }

  return { ok: true };
}

// Builds a fresh env object from scratch rather than spreading process.env
// and deleting keys — that way a future secret-bearing var added to
// process.env is excluded by default instead of needing to be remembered
// as a new thing to strip. The fixed values additionally stop git from
// opening an interactive credential prompt, reading system-wide config, or
// invoking a pager/editor that could itself run code.
function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
  };
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// Truncates `formatted` to MAX_OUTPUT_BYTES UTF-8 bytes, keeping the front
// of the string and appending a short note in place of the tail — same
// "keep the head, note what was cut" shape as list-directory.ts's
// 200-entry cap. Slicing the encoded Buffer (not the JS string) is what
// makes the cap a byte cap rather than a UTF-16-code-unit cap; a trailing
// multi-byte character split by the cut is turned into a single U+FFFD by
// Buffer#toString, which is acceptable for a truncated tail.
function capOutput(formatted: string): string {
  const bytes = Buffer.byteLength(formatted, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) {
    return formatted;
  }
  const noteBytes = Buffer.byteLength(TRUNCATION_NOTE, "utf8");
  const budget = Math.max(MAX_OUTPUT_BYTES - noteBytes, 0);
  const kept = Buffer.from(formatted, "utf8").subarray(0, budget).toString("utf8");
  return kept + TRUNCATION_NOTE;
}

// Builds the exact "exit=<code>\n<stdout>\n<stderr>" string (literal
// newlines even when stdout/stderr are empty), then runs it through
// sanitizeForTerminal before capping — git output could contain ANSI codes
// (e.g. from --decorate if git's own color auto-detection ever misfires
// with no attached TTY), and this is exactly the "any tool result" case
// the standing sanitization requirement covers. Sanitizing before capping
// means the 20 KB budget applies to what the caller actually receives.
function formatResult(exitCode: number, stdout: string, stderr: string): string {
  const raw = `exit=${exitCode}\n${stdout}\n${stderr}`;
  return capOutput(sanitizeForTerminal(raw));
}

/**
 * Implements the git tool. Validates `args` via validateGitArgs and rejects
 * (rule 9) before ever spawning a process if validation fails. Otherwise
 * runs `execFile("git", args, { cwd, shell: false, timeout: 15000,
 * maxBuffer: 1_000_000, env })` with the scrubbed environment from
 * buildGitEnv. `shell: false` is passed explicitly (it is already
 * execFile's default) to make the intent visible in this security-critical
 * call: it is what prevents shell metacharacter injection through any
 * argument, since args are passed straight to the OS process-creation call
 * rather than through a shell that would re-interpret them.
 *
 * Resolves with the formatted/sanitized/capped "exit=0\n…\n…" string on a
 * clean exit. Rejects with an Error whose message is that same
 * formatted/sanitized/capped string on a non-zero exit (rule 7), so a
 * diagnostic such as "not a git repository" survives for the caller to
 * surface as an is_error tool_result rather than being swallowed as a
 * success. Rejects with a short, distinct message if the timeout killed
 * the process (rule 8) — no exit code exists in that case, so none is
 * fabricated. Rejects with a short, sanitized message in the (unspecified
 * by the contract, but possible) case where git could not even be spawned
 * at all, for the same reason: no exit code to format.
 */
export async function runGit(args: unknown, cwd: string): Promise<string> {
  const validation = validateGitArgs(args);
  if (!validation.ok) {
    throw new Error(`git tool rejected: ${validation.reason}`);
  }
  // Safe: validateGitArgs has already confirmed every element is a string.
  const validatedArgs = args as string[];
  const env = buildGitEnv();

  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      validatedArgs,
      { cwd, shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(formatResult(0, stdout, stderr));
          return;
        }
        if (error.killed) {
          reject(new Error("git command timed out after 15 seconds"));
          return;
        }
        if (typeof error.code === "number") {
          reject(new Error(formatResult(error.code, stdout, stderr)));
          return;
        }
        // The process never produced an exit code at all (e.g. the git
        // binary itself could not be spawned) — report this distinctly
        // instead of fabricating a fake exit code for it.
        reject(new Error(sanitizeForTerminal(`failed to run git: ${error.message}`)));
      },
    );
  });
}
