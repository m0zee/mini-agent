import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { resolveUserMessage } from "../src/cli.js";
import { discoverSkills } from "../src/skills/discover.js";
import { buildTools, type BuildToolsResult } from "../src/tools/index.js";
import type { Trace } from "../src/trace.js";

// Scope note: --help, --list-skills, one-shot mode, and the REPL are
// process-level behaviors (argv parsing, stdout/stdin, process exit codes)
// that can only be observed by spawning the real CLI as a subprocess — out
// of scope for node:test unit tests, per agent-prompt.md's explicit
// instruction. That is what T11's scripts/smoke.ts and manual verification
// are for. resolveUserMessage is the one piece of cli.ts pure enough to
// exercise directly here, against real discoverSkills/buildTools output
// (never a hand-rolled stand-in for either).

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");
const SENTINEL = "SENTINEL-BODY-TEXT-DO-NOT-LEAK";

function createCapturingTrace(): { trace: Trace; infoCalls: string[] } {
  const infoCalls: string[] = [];
  const trace: Trace = {
    info(message: string): void {
      infoCalls.push(message);
    },
    debug(): void {
      // Unused by resolveUserMessage.
    },
  };
  return { trace, infoCalls };
}

async function buildFixtureTools(): Promise<BuildToolsResult> {
  const discovered = await discoverSkills(FIXTURES_ROOT);
  return buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: discovered.skills });
}

test("resolveUserMessage: /skill-name matching a real discovered skill returns the activated content plus the trailing remainder, and logs the activation", async () => {
  const tools = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  const result = await resolveUserMessage("/valid-with-refs please summarize this", tools, trace);

  assert.ok(result.includes(SENTINEL), "expected the activated skill body (sentinel) in the result");
  assert.ok(
    result.includes("please summarize this"),
    "expected the remaining text appended after the activated content",
  );
  assert.ok(
    infoCalls.some((line) => line.includes("skill activated: valid-with-refs")),
    "expected the activation to be logged via trace.info",
  );
});

test("resolveUserMessage: /skill-name with no trailing text returns just the activated content, unchanged by an empty remainder", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const result = await resolveUserMessage("/valid-with-refs", tools, trace);

  assert.ok(result.includes(SENTINEL));
  assert.ok(result.startsWith("<skill_content "));
});

test("resolveUserMessage: a /-prefixed input that does not match any discovered skill name is returned completely unchanged", async () => {
  const tools = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  const input = "/not-a-real-skill do something";
  const result = await resolveUserMessage(input, tools, trace);

  assert.equal(result, input);
  assert.equal(infoCalls.length, 0, "no activation should have been logged");
});

test("resolveUserMessage: plain input with no leading slash is returned unchanged", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const input = "what's the weather?";
  const result = await resolveUserMessage(input, tools, trace);

  assert.equal(result, input);
});

test('resolveUserMessage: a bare "/" with nothing after it is returned unchanged, not a crash', async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const result = await resolveUserMessage("/", tools, trace);

  assert.equal(result, "/");
});

test("resolveUserMessage: matching is exact and case-sensitive against the raw name — a differently-cased name is not treated as an activation", async () => {
  const tools = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  const input = "/Valid-With-Refs something";
  const result = await resolveUserMessage(input, tools, trace);

  assert.equal(result, input);
  assert.equal(infoCalls.length, 0);
});

test("resolveUserMessage: when tools.execute reports isError for a matched name, it throws with that message instead of silently falling through to the unchanged input", async () => {
  const real = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  // A minimal stand-in that reuses the real discovered skills (so the name
  // match succeeds) but forces execute() to fail, simulating e.g. a skill
  // file removed between discovery and activation — a scenario SkillActivator
  // itself already covers at a lower layer; this only proves cli.ts
  // propagates that failure as a thrown error rather than treating the input
  // as an ordinary, unchanged prompt.
  const failingTools: BuildToolsResult = {
    ...real,
    execute: async () => ({ output: "SKILL.md is no longer readable", isError: true }),
  };

  await assert.rejects(
    () => resolveUserMessage("/valid-with-refs hello", failingTools, trace),
    (err: unknown) => err instanceof Error && err.message === "SKILL.md is no longer readable",
  );
  assert.equal(infoCalls.length, 0, "a failed activation must not be logged as a successful one");
});
