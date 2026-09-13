import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent, MAX_ITERATIONS, type AgentTools } from "../src/agent.js";
import { discoverSkills } from "../src/skills/discover.js";
import type { SkillRecord } from "../src/skills/types.js";
import { buildTools } from "../src/tools/index.js";
import type { Trace } from "../src/trace.js";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");
const MODEL = "claude-sonnet-5";
const SYSTEM_PROMPT = "test system prompt";
const SENTINEL = "SENTINEL-BODY-TEXT-DO-NOT-LEAK";

// --- fixture builders ------------------------------------------------------

// Fills in every field the real Anthropic.Message type requires beyond
// content/stop_reason, with fixed placeholder values agent.ts reads (usage)
// or never reads (id, model, ...). Kept in one place so each test only has
// to state
// the two fields it actually cares about.
function makeMessage(content: Anthropic.ContentBlock[], stopReason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content,
    model: MODEL,
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

// A hand-written stub implementing only .messages.create, per the spec: no
// network, real SDK client is never constructed. Records a deep SNAPSHOT of
// each call's params, not the live object: agent.ts reuses and mutates
// (pushes onto) the same `messages` array across loop iterations, so
// storing the reference itself would make every earlier call's recorded
// `messages` silently reflect the FINAL state of the array once run()
// finishes, instead of what was actually sent at that call.
function createStubClient(
  handler: (params: Anthropic.MessageCreateParamsNonStreaming, callIndex: number) => Anthropic.Message,
): { client: Anthropic; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const stub = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push(structuredClone(params));
        return handler(params, calls.length - 1);
      },
    },
  };
  return { client: stub as unknown as Anthropic, calls };
}

function createCapturingTrace(): { trace: Trace; infoCalls: string[]; debugCalls: string[] } {
  const infoCalls: string[] = [];
  const debugCalls: string[] = [];
  const trace: Trace = {
    info(message: string): void {
      infoCalls.push(message);
    },
    debug(message: string): void {
      debugCalls.push(message);
    },
  };
  return { trace, infoCalls, debugCalls };
}

async function buildFixtureTools(): Promise<AgentTools> {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const built = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });
  return { definitions: built.definitions, execute: built.execute };
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeSkill(overrides: Partial<SkillRecord> & { location: string; dir: string }): SkillRecord {
  return {
    name: "temp-skill",
    description: "A temp skill for testing.",
    metadata: {},
    ...overrides,
  };
}

// Every content block (or bare string content) across `messages` whose
// serialized form contains the sentinel, tagged with the block's `type` (or
// "string-content" for a plain-string message body) so a test can assert
// both the count and which kind of block it landed in.
function findSentinelOccurrences(messages: Anthropic.MessageParam[]): Array<{ type: string }> {
  const found: Array<{ type: string }> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.includes(SENTINEL)) {
        found.push({ type: "string-content" });
      }
      continue;
    }
    for (const block of message.content) {
      if (JSON.stringify(block).includes(SENTINEL)) {
        found.push({ type: block.type });
      }
    }
  }
  return found;
}

// --- basic tool_use -> end_turn flow ---------------------------------------

test("run(): tool_use then end_turn — sentinel absent before activation, present in exactly one tool_result after, final answer is the end_turn text only", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const { client, calls } = createStubClient((_params, callIndex) => {
    if (callIndex === 0) {
      return makeMessage(
        [toolUseBlock("tu_1", "activate_skill", { name: "valid-with-refs" })],
        "tool_use",
      );
    }
    return makeMessage([textBlock("Done.")], "end_turn");
  });

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("hello");

  assert.equal(calls.length, 2);

  const beforeActivation = findSentinelOccurrences(calls[0].messages);
  assert.deepEqual(beforeActivation, []);

  const afterActivation = findSentinelOccurrences(calls[1].messages);
  assert.equal(afterActivation.length, 1);
  assert.equal(afterActivation[0].type, "tool_result");

  assert.equal(result, "Done.");
});

// --- two tool_use blocks in one turn -> one user message, two tool_results -

async function runTwoIdenticalActivations(): Promise<{
  calls: Anthropic.MessageCreateParamsNonStreaming[];
  trace: { infoCalls: string[]; debugCalls: string[] };
  result: string;
}> {
  const tools = await buildFixtureTools();
  const { trace, infoCalls, debugCalls } = createCapturingTrace();

  const { client, calls } = createStubClient((_params, callIndex) => {
    if (callIndex === 0) {
      return makeMessage(
        [
          toolUseBlock("tu_1", "activate_skill", { name: "valid-with-refs" }),
          toolUseBlock("tu_2", "activate_skill", { name: "valid-with-refs" }),
        ],
        "tool_use",
      );
    }
    return makeMessage([textBlock("Done.")], "end_turn");
  });

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("activate it twice");

  return { calls, trace: { infoCalls, debugCalls }, result };
}

test("run(): two tool_use blocks in one turn produce exactly one new user message with two tool_results, in order, executed sequentially not concurrently", async () => {
  const { calls } = await runTwoIdenticalActivations();

  assert.equal(calls.length, 2);
  const secondCallMessages = calls[1].messages;

  // messages = [user(text), assistant(2 tool_use), user(2 tool_result)] —
  // exactly one new user message beyond the original turn, not two.
  assert.equal(secondCallMessages.length, 3);
  const toolResultMessage = secondCallMessages[2];
  assert.equal(toolResultMessage.role, "user");
  assert.ok(Array.isArray(toolResultMessage.content));
  const resultBlocks = toolResultMessage.content as Anthropic.ToolResultBlockParam[];
  assert.equal(resultBlocks.length, 2);
  assert.equal(resultBlocks[0].type, "tool_result");
  assert.equal(resultBlocks[1].type, "tool_result");
  assert.equal(resultBlocks[0].tool_use_id, "tu_1");
  assert.equal(resultBlocks[1].tool_use_id, "tu_2");

  // The race this proves closed: sequential execution means the FIRST call
  // observes "not yet active" and returns the full body/sentinel, and the
  // SECOND call observes "already active" and returns the fixed no-op
  // message instead — never both full, which is what Promise.all would
  // produce (SkillActivator.activate has a check-then-act race).
  const firstContent = String(resultBlocks[0].content);
  const secondContent = String(resultBlocks[1].content);
  assert.ok(firstContent.includes(SENTINEL), "first activation should contain the full body/sentinel");
  assert.ok(
    secondContent.includes("is already active in this session"),
    "second activation should be the already-active no-op, not full content",
  );
  assert.ok(
    !secondContent.includes(SENTINEL),
    "second activation must NOT contain the sentinel — if it does, execution was concurrent, not sequential",
  );
});

test('run(): activation trace logging fires exactly once for two activate_skill calls of the same skill in one turn', async () => {
  const { trace } = await runTwoIdenticalActivations();

  const activationLines = trace.infoCalls.filter((line) => line.includes("skill activated: valid-with-refs"));
  assert.equal(activationLines.length, 1);
});

// --- iteration cap ----------------------------------------------------------

test("run(): iteration cap — calls create exactly MAX_ITERATIONS times, resolves cleanly, and warns via trace.info", async () => {
  const tools = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  const { client, calls } = createStubClient((_params, callIndex) =>
    makeMessage([toolUseBlock(`tu_${callIndex}`, "list_directory", {})], "tool_use"),
  );

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("loop forever please");

  assert.equal(calls.length, MAX_ITERATIONS);
  assert.equal(calls.length, 12);
  assert.equal(result, "");
  assert.ok(infoCalls.some((line) => /iteration cap/i.test(line)));
});

// --- max_tokens stop_reason --------------------------------------------------

test('run(): stop_reason "max_tokens" returns the partial text and logs a truncation warning', async () => {
  const tools = await buildFixtureTools();
  const { trace, infoCalls } = createCapturingTrace();

  const { client } = createStubClient(() => makeMessage([textBlock("partial answer")], "max_tokens"));

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("say something long");

  assert.equal(result, "partial answer");
  assert.ok(infoCalls.some((line) => /max_tokens|truncat/i.test(line)));
});

// --- refusal stop_reason ------------------------------------------------------

test('run(): stop_reason "refusal" returns a short generic notice, never the model\'s own content', async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const { client } = createStubClient(() =>
    makeMessage([textBlock("SHOULD_NOT_APPEAR_IN_OUTPUT")], "refusal"),
  );

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("do something disallowed");

  assert.ok(result.length > 0);
  assert.ok(!result.includes("SHOULD_NOT_APPEAR_IN_OUTPUT"));
});

// --- sanitizeForTerminal applied to the final answer -------------------------

test("run(): a raw ANSI escape in the final end_turn text is stripped from the returned string", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  // Built with String.fromCharCode, never a literal escape byte typed into
  // this source file (the exact defect class T6/T7/T8 already hit).
  const esc = String.fromCharCode(0x1b);
  const dirtyText = `before${esc}[31mRED${esc}[0mafter`;

  const { client } = createStubClient(() => makeMessage([textBlock(dirtyText)], "end_turn"));

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("print something with color codes");

  assert.ok(!result.includes(esc), "expected no raw ESC byte to survive sanitization");
  assert.equal(result, "beforeREDafter");
});

// --- history parameter --------------------------------------------------------

test("run(): passed-in history is included, in order, before the new user message", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];

  const { client, calls } = createStubClient(() => makeMessage([textBlock("Done.")], "end_turn"));

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  await agent.run("new question", history);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, [...history, { role: "user", content: "new question" }]);
});

// --- no thinking/tool_choice params sent --------------------------------------

test("run(): never sends a thinking or tool_choice param", async () => {
  const tools = await buildFixtureTools();
  const { trace } = createCapturingTrace();

  const { client, calls } = createStubClient(() => makeMessage([textBlock("Done.")], "end_turn"));

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  await agent.run("hello");

  assert.equal(calls.length, 1);
  assert.ok(!("thinking" in calls[0]));
  assert.ok(!("tool_choice" in calls[0]));
});

// --- regression: activation logging must not false-suppress on genuine ------
// first activations whose skill body (or name) happens to contain the
// activator's own "already active" phrase as ordinary text.

test('run(): a genuine first activation is still logged even when the skill BODY contains the literal phrase "is already active in this session" as ordinary prose', async () => {
  await withTempDir("mini-agent-agent-test-phrase-", async (dir) => {
    const frontmatter = [
      "---",
      "name: phrase-in-body-skill",
      "description: A fixture skill whose body legitimately contains the already-active phrase as prose.",
      "---",
      "",
      "This skill discusses session lifecycles in an unrelated system. For",
      "example: a user's login session is already active in this session in",
      "that other system, which has nothing to do with skill activation",
      "tracking here.",
    ].join("\n");
    const location = path.join(dir, "SKILL.md");
    await writeFile(location, frontmatter, "utf8");
    const skill = makeSkill({ name: "phrase-in-body-skill", location, dir });

    const built = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [skill] });
    const tools: AgentTools = { definitions: built.definitions, execute: built.execute };
    const { trace, infoCalls } = createCapturingTrace();

    const { client } = createStubClient((_params, callIndex) => {
      if (callIndex === 0) {
        return makeMessage(
          [toolUseBlock("tu_1", "activate_skill", { name: "phrase-in-body-skill" })],
          "tool_use",
        );
      }
      return makeMessage([textBlock("Done.")], "end_turn");
    });

    const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
    await agent.run("activate the phrase skill");

    // This is the inverse of the earlier "already active" test: a NEGATIVE
    // substring check against the fixed already-active phrase would be
    // fooled by this body and silently suppress the mandatory activation
    // log on a genuine first activation — the exact false-positive bug
    // being regression-tested here.
    assert.ok(
      infoCalls.some((line) => line.includes("skill activated: phrase-in-body-skill")),
      "a genuine first activation must be logged even though the skill body contains the already-active phrase",
    );
  });
});

// --- intermediate assistant text is logged via trace.debug, never dropped --

test("run(): intermediate assistant text alongside a tool_use block in the same turn is logged via trace.debug (never sent to stdout, never silently dropped)", async () => {
  const tools = await buildFixtureTools();
  const { trace, debugCalls } = createCapturingTrace();

  const { client } = createStubClient((_params, callIndex) => {
    if (callIndex === 0) {
      return makeMessage(
        [textBlock("Let me check that for you."), toolUseBlock("tu_1", "list_directory", {})],
        "tool_use",
      );
    }
    return makeMessage([textBlock("Done.")], "end_turn");
  });

  const agent = new Agent({ client, model: MODEL, systemPrompt: SYSTEM_PROMPT, tools, trace });
  const result = await agent.run("do something");

  assert.ok(
    debugCalls.some((line) => line.includes("Let me check that for you.")),
    "intermediate assistant text must be captured via trace.debug",
  );
  // The intermediate text must never leak into the final returned answer —
  // stdout (what run() returns) stays final-turn-only.
  assert.equal(result, "Done.");
});
