import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeForTerminal } from "./text.js";

/**
 * Every error the CLI surfaces to a user (a failed one-shot prompt, a failed
 * REPL turn, a fatal startup error, or a genuinely uncaught exception) is
 * also appended here so it can be traced after the terminal window closes.
 * Default location: `<cwd>/mini-agent-error.log` — the same directory the
 * CLI was invoked from, matching `--skills-dir`'s own `<cwd>/.skills`
 * default rather than a fixed location outside the project. Overridable via
 * `MINI_AGENT_LOG_FILE`, matching the flag/env/default precedence already
 * used for `--skills-dir`/`--model` elsewhere in this project (this one has
 * no CLI flag counterpart, since a logging destination isn't part of the
 * spec'd flag surface — env-only keeps it a debugging aid, not a new
 * user-facing option to document/test to the same bar as `--skills-dir`).
 * Resolved fresh on every call (not cached at import time), so it correctly
 * reflects whatever `process.cwd()` is at the moment an error actually
 * occurs, not wherever the process happened to start.
 */
function resolveLogFilePath(): string {
  return process.env.MINI_AGENT_LOG_FILE ?? join(process.cwd(), "mini-agent-error.log");
}

/** Exposed so `cli.ts` can tell the user where to look (`--help` text) and so tests can point elsewhere. */
export function getLogFilePath(): string {
  return resolveLogFilePath();
}

// One entry per error: an ISO timestamp, a short context label identifying
// WHERE it was caught (e.g. "one-shot", "repl-turn", "uncaughtException"),
// the error's constructor name, its message, and its stack trace when
// available. A stack trace reveals file paths and line numbers, never
// secrets — the same holds for every `err.message` this project already
// surfaces to stderr via `describeError()` in cli.ts, none of which ever
// includes the API key itself (Anthropic SDK errors don't echo it back).
// Passed through `sanitizeForTerminal` so a hostile or attacker-influenced
// error message can't inject terminal escape sequences into whoever later
// `cat`s or `tail`s this file — the same standing requirement applied to
// every other string this project writes to a terminal.
function formatLogEntry(context: string, err: unknown): string {
  const timestamp = new Date().toISOString();
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
  return sanitizeForTerminal(`[${timestamp}] [${context}] ${name}: ${message}${stack}\n`);
}

/**
 * Appends one entry to the error log. NEVER throws and never rejects: a
 * logging failure (no write permission, a full disk, an uncreatable
 * directory) must not mask or replace the original error already being
 * shown to the user on stderr. A logging failure is itself reported only
 * under `--debug`, via the optional `trace` parameter, and otherwise
 * swallowed silently. Returns whether the entry was actually written —
 * `cli.ts` uses this to decide whether it's honest to tell the user "see
 * the log file", rather than pointing them at a file that was never
 * written.
 */
export async function logErrorToFile(
  context: string,
  err: unknown,
  trace?: { debug(message: string): void },
): Promise<boolean> {
  const logFilePath = resolveLogFilePath();
  try {
    await mkdir(dirname(logFilePath), { recursive: true });
    await appendFile(logFilePath, formatLogEntry(context, err), "utf8");
    return true;
  } catch (logErr) {
    trace?.debug(`failed to write error log (${logFilePath}): ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    return false;
  }
}
