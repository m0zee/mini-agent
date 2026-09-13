import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { SkillActivator } from "../skills/activate.js";
import { dedupeSkillsByName } from "../skills/dedupe.js";
import type { Diagnostic, SkillRecord } from "../skills/types.js";
import { sanitizeForTerminal } from "../text.js";
import { buildActivateSkillDefinition } from "./activate-skill.js";
import type { FsContext } from "./fs-guard.js";
import { runGit } from "./git.js";
import { listDirectory } from "./list-directory.js";
import { readFile } from "./read-file.js";

export interface BuildToolsContext {
  cwd: string;
  skillsRoot: string;
  skills: SkillRecord[];
}

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
}

export interface BuildToolsResult {
  definitions: Anthropic.Tool[];
  execute: (name: string, input: unknown) => Promise<ToolExecutionResult>;
  skills: SkillRecord[];
  // WARN diagnostics from dedupeSkillsByName (one per skill name that had a
  // duplicate discarded — e.g. a skill directory reachable twice under the
  // skills root via a Windows junction). These are a distinct diagnostics
  // stream from discoverSkills's own: T10's cli.ts must print BOTH together
  // at startup and for --list-skills (e.g.
  // [...discovered.diagnostics, ...tools.diagnostics]), or a dropped
  // duplicate skill silently produces no observable warning anywhere.
  diagnostics: Diagnostic[];
}

const READ_FILE_DESCRIPTION =
  "Reads a UTF-8 text file and returns its contents. Refuses files over 100 KB and refuses binary " +
  "files (detected by a NUL byte in the first 8 KB). `path` may be relative (resolved against the " +
  "working directory) or absolute; either way it must resolve inside the working directory or the " +
  "skills directory.";

const LIST_DIRECTORY_DESCRIPTION =
  "Lists the immediate entries of a directory, one per line (directories suffixed \"/\"), " +
  "non-recursively: only a single directory level is shown, never descending into subdirectories. " +
  "Omit `path` to list the working directory. `path` must resolve inside the working directory or " +
  "the skills directory.";

// This description is deliberately detailed (per T7's finding): the model
// should be steered toward exact accepted argument forms up front, rather
// than discovering the allowlist by trial and error through rejected calls.
// It lists every one of the 15 allowed flags and 9 allowed value-flag
// prefixes explicitly (this is a closed allowlist, not a representative
// sample), warns against quoting values (execFile runs with shell: false,
// so a quoted example like --since="2 weeks ago" would pass the literal
// quote characters straight to git as part of the value — proven to
// visibly corrupt --pretty=/--format= output), and notes the maxBuffer
// failure mode separately from the 20 KB truncation cap.
const GIT_DESCRIPTION =
  'Runs a read-only git query and returns "exit=<code>" followed by stdout and stderr, capped to ' +
  "20 KB when the command completes successfully. Output of roughly 1 MB or more fails outright " +
  "with an error instead of being truncated, so keep queries narrow (-n, --max-count=, --oneline, " +
  "--stat). Only these subcommands are allowed: log, show, diff, status, tag, describe, rev-parse, " +
  "shortlog, branch, ls-files — no other subcommand, and no global option (e.g. -c) may appear " +
  "before the subcommand. Only these flags are allowed, exactly: --oneline, --stat, --name-only, " +
  "--name-status, --no-merges, --reverse, --decorate, --abbrev-commit, --list, --tags, --all, " +
  '--short, --porcelain, --cached, and -n given as its OWN argument (["log","-n","5"] — never ' +
  'attached like "-n5"). Flags that take a value must use the "=" form in a single argument, never ' +
  "a separate argument: --max-count=, --since=, --until=, --after=, --before=, --author=, " +
  '--pretty=, --format=, --date= (e.g. --since=2 weeks ago, --pretty=format:%s — a space-separated ' +
  'form like ["log","--max-count","5"] is rejected). Arguments are passed directly to git with no ' +
  "shell — never wrap a value in quotes; the quotes become part of the value. \"branch\" and \"tag\" " +
  "require --list whenever a pattern or name is also given — a bare name (e.g. " +
  '["branch","foo"]) is rejected because it would create a ref, not filter one. A bare "--" ' +
  "pathspec separator is not supported and is rejected.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorResult(message: string): ToolExecutionResult {
  return { output: sanitizeForTerminal(message), isError: true };
}

function successResult(output: string): ToolExecutionResult {
  return { output: sanitizeForTerminal(output), isError: false };
}

/**
 * Wires the fixed read-only tool surface (read_file, list_directory, git)
 * plus, when there is at least one skill, activate_skill, into a single
 * `{ definitions, execute, skills }` bundle for the agent loop (a later
 * task) to drive.
 *
 * `ctx.cwd` and `ctx.skillsRoot` are resolved to absolute paths before use:
 * a relative or unnormalized root would otherwise resolve against the
 * process's own cwd rather than the intended one, silently producing a
 * broken (fails-closed, but confusing) FsContext.
 *
 * `ctx.skills` is deduped exactly once, here, by `dedupeSkillsByName`
 * (first-occurrence-wins) — the resulting array is what builds both the
 * `activate_skill` enum and the `SkillActivator`, and is also returned as
 * this function's own `skills` field so a caller (T10's cli.ts) can reuse
 * that exact same array for `buildSystemPrompt`/`renderCatalog` instead of
 * deduping a second time with potentially different logic.
 *
 * One `SkillActivator` is constructed here and closed over by `execute`, so
 * the same instance (and its dedupe/"already active" tracking) is reused
 * across every tool call for the lifetime of this `buildTools` result.
 */
export function buildTools(ctx: BuildToolsContext): BuildToolsResult {
  const cwd = path.resolve(ctx.cwd);
  const skillsRoot = path.resolve(ctx.skillsRoot);
  const { skills, diagnostics } = dedupeSkillsByName(ctx.skills);

  const fsContext: FsContext = { cwd, roots: [cwd, skillsRoot] };
  const activator = new SkillActivator(skills);

  const definitions: Anthropic.Tool[] = [
    {
      name: "read_file",
      description: READ_FILE_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, relative to the working directory or absolute.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_directory",
      description: LIST_DIRECTORY_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path; omit to list the working directory.",
          },
        },
      },
    },
    {
      name: "git",
      description: GIT_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: {
          args: {
            type: "array",
            items: { type: "string" },
            description: 'git argv, e.g. ["log","--oneline","-n","5"].',
          },
        },
        required: ["args"],
      },
    },
  ];

  // Matches the "no skills -> no catalog, no tool" rule already implemented
  // in prompt.ts: with zero skills, activate_skill is omitted entirely, not
  // even registered as a stub with an empty enum.
  if (skills.length > 0) {
    definitions.push(buildActivateSkillDefinition(skills));
  }

  const knownToolNames = new Set(definitions.map((tool) => tool.name));

  async function execute(name: string, input: unknown): Promise<ToolExecutionResult> {
    try {
      if (!knownToolNames.has(name)) {
        return errorResult(`unknown tool: "${name}"`);
      }

      // Minimal defensive guard: the underlying tool functions already do
      // their own runtime type checks and throw on bad input (caught by the
      // try/catch below), but a non-object input like `42` or `"x"` would
      // otherwise crash on property access before ever reaching them.
      if (!isPlainObject(input)) {
        return errorResult(`${name}: input must be an object`);
      }

      switch (name) {
        case "read_file": {
          const output = await readFile(input.path, fsContext);
          return successResult(output);
        }
        case "list_directory": {
          const output = await listDirectory(input.path, fsContext);
          return successResult(output);
        }
        case "git": {
          const output = await runGit(input.args, cwd);
          return successResult(output);
        }
        case "activate_skill": {
          if (typeof input.name !== "string") {
            return errorResult("activate_skill: name must be a string");
          }
          const output = await activator.activate(input.name);
          return successResult(output);
        }
        default:
          // Unreachable: knownToolNames only ever contains the names
          // handled above.
          return errorResult(`unknown tool: "${name}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  }

  return { definitions, execute, skills, diagnostics };
}
