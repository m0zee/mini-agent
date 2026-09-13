#!/usr/bin/env node
import { parseArgs } from "node:util";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";
import { discoverSkills } from "./skills/discover.js";
import type { Diagnostic, SkillRecord } from "./skills/types.js";
import { sanitizeForTerminal } from "./text.js";
import { buildTools, type BuildToolsResult } from "./tools/index.js";
import { createTrace, type Trace } from "./trace.js";

const DEFAULT_MODEL = "claude-sonnet-5";

const USAGE = `mini-agent [--skills-dir <path>] [--model <id>] [--debug] [--list-skills] [--help] [prompt...]

A small read-only coding agent, powered by Claude, that implements the Agent Skills spec.

Options:
  --skills-dir <path>  Directory to discover skills from
                        (default: $MINI_AGENT_SKILLS_DIR or <cwd>/.skills)
  --model <id>          Claude model id to use (default: $MINI_AGENT_MODEL or ${DEFAULT_MODEL})
  --debug               Print the constructed system prompt, intermediate tool-calling turns, tool
                         inputs, and token usage to stderr
  --list-skills         Print discovered skills and diagnostics, then exit (no API key or network
                         access required)
  --help                Print this message and exit

If a prompt is given as positional arguments, mini-agent runs it once and prints the final answer
to stdout. Otherwise it starts an interactive REPL (type "exit", "quit", or press Ctrl-D to leave).
A prompt (one-shot or in the REPL) that starts with "/<skill-name>" for a discovered skill
explicitly activates that skill before the rest of the text is sent.

Examples:
  mini-agent "I'm new to this project, what should I do?"
  mini-agent "Generate a changelog for the last 5 commits"
  mini-agent --debug "what's the weather?"
  mini-agent --list-skills
`;

// Thrown by resolveUserMessage when an explicit "/skill-name" activation
// fails (tools.execute returned isError: true) — a user-facing condition,
// distinct from an SDK/network error, that callers map to a one-line stderr
// message per agent-prompt.md's CLI section (exit 1 in one-shot mode,
// re-prompt in REPL mode) rather than letting it fall through as if the
// input were an ordinary, non-activation prompt.
class SkillActivationError extends Error {}

/**
 * Resolves one raw line of user input into the text actually sent to the
 * agent. Explicit "/skill-name" activation (client-implementation guide's
 * "user-explicit activation"): when `rawInput` starts with "/" and the text
 * up to the first whitespace (or end of string) EXACTLY matches one of
 * `tools.skills`'s raw (non-NFKC) names, this calls `activate_skill` itself
 * and returns the activated content followed by any remaining text — no
 * ambiguity here, so no heuristic is needed, unlike the model-driven path.
 * Any other input (no leading "/", or a name that doesn't match a
 * discovered skill exactly) is returned completely unchanged: a message
 * starting with "/" that isn't a known skill name is an ordinary prompt
 * (e.g. asking about a literal path or command), not an activation attempt.
 *
 * Exported for testing; used identically for both the one-shot prompt and
 * every REPL input line, per agent-prompt.md's CLI section.
 */
export async function resolveUserMessage(
  rawInput: string,
  tools: BuildToolsResult,
  trace: Trace,
): Promise<string> {
  if (!rawInput.startsWith("/")) {
    return rawInput;
  }

  const afterSlash = rawInput.slice(1);
  const whitespaceMatch = afterSlash.match(/\s/);
  const name = whitespaceMatch ? afterSlash.slice(0, whitespaceMatch.index) : afterSlash;

  if (name.length === 0) {
    // Just "/" with nothing after it — not a crash, not an activation
    // attempt, just an ordinary (if odd) prompt.
    return rawInput;
  }

  // Exact, case-sensitive match against the raw (non-NFKC) name only — no
  // fuzzy matching, per the standing requirement that SkillRecord.name's raw
  // form is used consistently everywhere, including here.
  const matchedSkill = tools.skills.find((skill) => skill.name === name);
  if (!matchedSkill) {
    return rawInput;
  }

  const remainder = whitespaceMatch ? afterSlash.slice(whitespaceMatch.index! + 1).trim() : "";

  const result = await tools.execute("activate_skill", { name });
  if (result.isError) {
    // Never silently fall through to treating this as an ordinary prompt:
    // the caller decides how to surface this (exit in one-shot, re-prompt
    // in REPL).
    throw new SkillActivationError(result.output);
  }

  // This path is a genuine, harness-driven activation (the user typed the
  // exact skill name), so it is logged directly rather than through the
  // agent loop's positive-prefix heuristic (agent.ts only ever sees
  // model-driven activate_skill calls).
  trace.info(`skill activated: ${name}`);

  return remainder.length > 0 ? `${result.output}\n\n${remainder}` : result.output;
}

function describeError(err: unknown): string {
  if (err instanceof SkillActivationError) {
    return err.message;
  }
  // Order matters: AuthenticationError and RateLimitError are subclasses of
  // APIError, so the generic APIError check must come last or it would
  // shadow the more specific ones.
  if (err instanceof Anthropic.AuthenticationError) {
    return `Authentication failed (check ANTHROPIC_API_KEY): ${err.message}`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return `Rate limited by the Anthropic API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error: ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unexpected error: ${message}`;
}

function writeStderrLine(text: string): void {
  process.stderr.write(`${sanitizeForTerminal(text)}\n`);
}

function writeStdoutLine(text: string): void {
  process.stdout.write(`${sanitizeForTerminal(text)}\n`);
}

// Shared by the always-on startup trace and --list-skills's stdout output so
// a diagnostic is never rendered two different ways: WHICH skill a
// diagnostic is about must never be dropped in either place (a startup-only
// "ERROR: Frontmatter is not valid YAML" with no skill name was a real
// usability regression found in review, since startup stderr is the only
// diagnostic output a normal, non---list-skills run ever produces).
function formatDiagnostic(diagnostic: Diagnostic): string {
  const level = diagnostic.level === "error" ? "ERROR" : "WARN";
  const skillPart = diagnostic.skill ? ` [${diagnostic.skill}]` : "";
  return `${level}${skillPart}: ${diagnostic.message}`;
}

// Always-on startup trace (non-negotiable fact: skills discovered/activated
// must be observable without --debug) plus every diagnostic from both
// streams — discoverSkills's own, and buildTools's dedupe warnings.
function logStartup(trace: Trace, skills: SkillRecord[], diagnostics: Diagnostic[]): void {
  if (skills.length > 0) {
    trace.info(`skills: ${skills.map((skill) => skill.name).join(", ")}`);
  } else {
    trace.info("no skills were found");
  }
  for (const diagnostic of diagnostics) {
    trace.info(formatDiagnostic(diagnostic));
  }
}

function formatSkillBlock(skill: SkillRecord): string {
  const lines = [`name: ${skill.name}`, `description: ${skill.description}`, `location: ${skill.location}`];
  if (skill.license) {
    lines.push(`license: ${skill.license}`);
  }
  if (skill.compatibility) {
    lines.push(`compatibility: ${skill.compatibility}`);
  }
  if (skill.allowedTools) {
    lines.push(`allowed-tools: ${skill.allowedTools}`);
  }
  if (Object.keys(skill.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(skill.metadata)}`);
  }
  return lines.join("\n");
}

// --list-skills output goes to STDOUT (inspectable, per agent-prompt.md —
// distinct from the startup trace, which always goes to stderr) and must
// never require constructing an Anthropic client: this function and its
// caller touch only `tools`/`diagnostics`, never `client`/`ANTHROPIC_API_KEY`.
function printSkillCatalog(skills: SkillRecord[], diagnostics: Diagnostic[]): void {
  if (skills.length === 0) {
    writeStdoutLine("No skills discovered.");
  } else {
    writeStdoutLine(skills.map(formatSkillBlock).join("\n\n"));
  }
  if (diagnostics.length > 0) {
    writeStdoutLine(diagnostics.map(formatDiagnostic).join("\n"));
  }
}

async function runOneShot(agent: Agent, tools: BuildToolsResult, trace: Trace, promptText: string): Promise<void> {
  try {
    const resolved = await resolveUserMessage(promptText, tools, trace);
    const answer = await agent.run(resolved);
    // Raw, unmodified text to stdout: no markdown rendering, nothing
    // prepended — this is what makes a skill's required header the literal
    // first line of stdout. agent.run() already sanitizes its return value;
    // writeStdoutLine's own sanitize pass is a no-op here, kept only for
    // defense in depth (the standing requirement that every string reaching
    // stdout routes through sanitizeForTerminal, "obviously safe" or not).
    writeStdoutLine(answer);
  } catch (err) {
    writeStderrLine(describeError(err));
    process.exitCode = 1;
  }
}

// Drives the REPL by iterating `rl` as an async iterator instead of issuing
// repeated question() calls. This is a correctness fix, not a style choice:
// an earlier question()-based version lost input under piped (non-TTY)
// stdin — when EOF arrives while a previous turn's agent.run() is still
// awaiting the network, readline had ALREADY emitted the subsequent lines as
// 'line' events with nothing listening via question() to receive them, so
// they were silently discarded and the REPL exited 0 as if nothing were
// wrong. The async-iterator form is backed by readline's own internal line
// buffer, so lines that arrive before this loop is ready to consume them are
// queued, not dropped — every line piped in (however many, however fast)
// gets processed. It also sidesteps the ERR_USE_AFTER_CLOSE crash the
// question()-based version had after EOF: the for-await loop simply ends
// when the stream closes, with no call made on an already-closed interface.
// (Do not swap this for rl.prompt(): calling it after EOF throws the same
// ERR_USE_AFTER_CLOSE — the prompt string is written to stdout directly
// instead.)
async function runRepl(agent: Agent, tools: BuildToolsResult, trace: Trace): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];

  try {
    process.stdout.write("> ");
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
          break;
        }

        try {
          const resolved = await resolveUserMessage(trimmed, tools, trace);
          const answer = await agent.run(resolved, history);
          writeStdoutLine(answer);
          history.push({ role: "user", content: resolved });
          history.push({ role: "assistant", content: answer });
        } catch (err) {
          // A per-turn failure never ends the session — only "exit"/"quit"/
          // Ctrl-D do. Nothing is pushed onto `history` for a failed turn.
          writeStderrLine(describeError(err));
        }
      }
      process.stdout.write("> ");
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "skills-dir": { type: "string" },
      model: { type: "string" },
      debug: { type: "boolean", default: false },
      "list-skills": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  // --help works with zero configuration: before touching skills, env, or
  // the API, per agent-prompt.md's explicit ordering requirement.
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    // .env is optional; a missing file throws ENOENT, which is expected and
    // silently swallowed — not every environment needs or has one.
    process.loadEnvFile();
  } catch {
    // Intentionally ignored.
  }

  const cwd = process.cwd();
  const skillsRoot = values["skills-dir"] ?? process.env.MINI_AGENT_SKILLS_DIR ?? path.join(cwd, ".skills");
  const model = values.model ?? process.env.MINI_AGENT_MODEL ?? DEFAULT_MODEL;
  const debugFlag = values.debug ?? false;
  const trace = createTrace(debugFlag);

  // buildTools MUST run before buildSystemPrompt/renderCatalog, and its
  // deduped tools.skills (not discoverSkills's raw output) is what feeds
  // both the system prompt and the activate_skill enum — otherwise the
  // catalog could advertise a skill the activator serves differently (the
  // divergence bug found and fixed during T5/T8 review).
  const discovered = await discoverSkills(skillsRoot);
  const tools = buildTools({ cwd, skillsRoot, skills: discovered.skills });
  const allDiagnostics: Diagnostic[] = [...discovered.diagnostics, ...tools.diagnostics];

  logStartup(trace, tools.skills, allDiagnostics);

  if (values["list-skills"]) {
    printSkillCatalog(tools.skills, allDiagnostics);
    process.exitCode = allDiagnostics.some((d) => d.level === "error") ? 1 : 0;
    return;
  }

  // Checked only once past --help/--list-skills, and before ever
  // constructing an Anthropic client or attempting a request.
  if (!process.env.ANTHROPIC_API_KEY) {
    writeStderrLine("ANTHROPIC_API_KEY is not set (see .env.example)");
    process.exitCode = 1;
    return;
  }

  // new Anthropic() reads ANTHROPIC_API_KEY from process.env automatically;
  // no apiKey option is passed, and there is no --api-key flag.
  const client = new Anthropic();
  const systemPrompt = buildSystemPrompt(cwd, tools.skills);
  // The only place the constructed system prompt is ever observable: dumping
  // it under --debug is how "the catalog is present but a skill's body is
  // not" (progressive disclosure's core claim) is verified from the CLI
  // itself, not just by reading source.
  trace.debug(`system prompt:\n${systemPrompt}`);
  const agent = new Agent({ client, model, systemPrompt, tools, trace });

  const promptText = positionals.join(" ");

  if (promptText.length > 0) {
    await runOneShot(agent, tools, trace, promptText);
    return;
  }

  await runRepl(agent, tools, trace);
}

// Guard against running the whole CLI as a side effect of import: test/cli.test.ts
// imports resolveUserMessage from this module to unit-test it directly (per
// agent-prompt.md's testing scope), and without this check that import alone
// would discover skills against the real cwd, check ANTHROPIC_API_KEY, and
// potentially start a REPL or set a nonzero exit code — none of which a test
// run should trigger. Only run main() when this file is the actual process
// entry point (`node --import tsx src/cli.ts ...` or the built dist/cli.js).
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    writeStderrLine(describeError(err));
    process.exitCode = 1;
  });
}
