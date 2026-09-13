import type Anthropic from "@anthropic-ai/sdk";
import { sanitizeForTerminal } from "./text.js";
import type { Trace } from "./trace.js";

// Iteration cap (plan.md §7 T7 / agent-prompt.md non-negotiable): a
// pathological loop where the model never stops calling tools must not run
// forever or exhaust the API budget. Named so both this module and its
// tests refer to the same number instead of a repeated magic literal.
export const MAX_ITERATIONS = 12;

const MAX_TOKENS = 16000;

// Fixed, generic notice returned for stop_reason "refusal" — the model's own
// content is never extracted or echoed in that case (agent-prompt.md: "do
// not attempt to extract or echo the model's actual content for this
// case"), so this string never varies with what the model actually said.
const REFUSAL_MESSAGE = "The model declined to respond to this request.";

// The fixed prefix SkillActivator (src/skills/activate.ts) uses to open its
// wrapped body on a genuine first activation. execute()'s return shape is
// just { output, isError } with no signal distinguishing a genuine first
// activation from a repeat "already active" no-op, so a "genuine
// activation" is detected POSITIVELY, by this prefix, rather than
// negatively (checking the output does NOT contain the fixed already-active
// phrase). The negative form is unsafe: a skill's own body — or even its
// name, which lenient loading allows to contain arbitrary text with only a
// WARN — can legitimately contain that exact phrase as ordinary prose,
// which would silently suppress the mandatory activation log on a genuine
// first activation. SkillActivator.activate's only two possible successful
// outputs are this wrapper (first activation) or the fixed already-active
// sentence (repeat) — the wrapper is the only one that can ever start with
// this prefix.
const SKILL_CONTENT_PREFIX = "<skill_content ";

export interface AgentToolExecutionResult {
  output: string;
  isError: boolean;
}

export interface AgentTools {
  definitions: Anthropic.Tool[];
  execute: (name: string, input: unknown) => Promise<AgentToolExecutionResult>;
}

export interface AgentOptions {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  tools: AgentTools;
  trace: Trace;
}

function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// Pulls a human-readable skill name out of an activate_skill call's `input`
// for the "skill activated: <name>" trace line, without assuming any
// particular shape beyond "an object with a string `name` field" — the same
// defensive shape the spec's own reference expression uses. Falls back to
// "unknown" rather than throwing: this is a logging path, not validation
// (tools/index.ts's execute() already validated the real input before ever
// calling the tool).
function activatedSkillName(input: unknown): string {
  if (input !== null && typeof input === "object" && "name" in input) {
    const name = (input as { name: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "unknown";
}

/**
 * Drives the manual tool-use loop against the Claude Messages API: build the
 * initial `messages` array from `history` plus the new user turn, then call
 * `client.messages.create` up to MAX_ITERATIONS times, executing every
 * `tool_use` block the model asks for and feeding the results back, until a
 * natural stop (`end_turn`, `max_tokens`, `refusal`, or anything else) ends
 * the loop.
 *
 * The client is injected via the constructor (never imported/instantiated
 * here) so tests can hand in a stub object implementing just
 * `.messages.create` — this class never talks to the network directly.
 */
export class Agent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly tools: AgentTools;
  private readonly trace: Trace;

  constructor(opts: AgentOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
    this.tools = opts.tools;
    this.trace = opts.trace;
  }

  async run(userText: string, history?: Anthropic.MessageParam[]): Promise<string> {
    const messages: Anthropic.MessageParam[] = [...(history ?? []), { role: "user", content: userText }];

    // Tracks the most recent response's content so the iteration-cap branch
    // (reached only when every single iteration ended in "tool_use") has
    // something to collect trailing text from, without an unsafe
    // non-null assertion on a variable TypeScript can't otherwise prove is
    // assigned by then.
    let lastContent: Anthropic.ContentBlock[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Per non-negotiable fact #6: no `thinking`, prefill, or `tool_choice`
      // — omitted entirely, not set to a default/falsy value.
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: this.systemPrompt,
        tools: this.tools.definitions,
        messages,
      });
      lastContent = response.content;

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });

        // Non-negotiable fact #7: intermediate tool-calling turn text goes
        // to stderr only with --debug — never stdout (stdout stays
        // final-answer-only, see the end_turn branch below), and never
        // silently dropped. This loop is the only place that ever sees an
        // intermediate turn at all: a later caller (cli.ts) only ever sees
        // this method's final return value, so this is the only place this
        // behavior can be implemented.
        const intermediateText = collectText(response.content);
        if (intermediateText.length > 0) {
          this.trace.debug(`intermediate text: ${intermediateText}`);
        }

        // plan.md's stderr policy explicitly lists "usage" among what
        // --debug should surface.
        this.trace.debug(
          `usage: input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens}`,
        );

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        // Sequential for...await — NEVER Promise.all or any other
        // concurrent construct. This is non-negotiable: two concurrent
        // activate_skill calls for the same name both observe "not yet
        // active" (SkillActivator.activate has a check-then-act race) and
        // both return the full body, doubling context and defeating the
        // dedupe/"already active" guarantee entirely. A plain sequential
        // loop is what closes that race, by construction, with no change
        // needed to SkillActivator itself.
        for (const block of toolUseBlocks) {
          // Logged BEFORE execute() runs, not after: a slow tool call (e.g.
          // a git command approaching its 15s timeout) should show up in a
          // live --debug trace the moment it starts, not only once it
          // finishes.
          this.trace.debug(`tool call: ${block.name} input=${JSON.stringify(block.input)}`);

          const result = await this.tools.execute(block.name, block.input);

          // Activation trace logging: only for a genuine first activation
          // of a skill, never for a repeat "already active" no-op, and
          // never for any other tool. This is intentionally scoped tighter
          // than the per-call debug log above — non-negotiable fact #7
          // requires "[mini-agent] skill activated: <name>" on stderr on
          // activation, not on every tool call. See SKILL_CONTENT_PREFIX's
          // comment for why this check is positive, not a negative
          // substring match against the already-active message.
          if (block.name === "activate_skill" && !result.isError && result.output.startsWith(SKILL_CONTENT_PREFIX)) {
            this.trace.info(`skill activated: ${activatedSkillName(block.input)}`);
          }

          // sanitizeForTerminal is applied here unconditionally, even
          // though the underlying tools already sanitize their own output
          // in most cases: this is the layer responsible for guaranteeing
          // it for ALL tools, including any future one that might not
          // self-sanitize. Idempotent, so re-sanitizing already-sanitized
          // output changes nothing.
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: sanitizeForTerminal(result.output),
            is_error: result.isError,
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      if (response.stop_reason === "end_turn") {
        return sanitizeForTerminal(collectText(response.content));
      }

      if (response.stop_reason === "max_tokens") {
        this.trace.info("response truncated: max_tokens reached before the model finished its turn");
        return sanitizeForTerminal(collectText(response.content));
      }

      if (response.stop_reason === "refusal") {
        // REFUSAL_MESSAGE is a fixed literal with no attacker-controlled
        // content, so sanitizing it is a no-op in practice — still routed
        // through sanitizeForTerminal per the standing requirement that no
        // string reaching stdout/stderr ever bypasses it, "obviously safe"
        // or not.
        return sanitizeForTerminal(REFUSAL_MESSAGE);
      }

      // Defensive fallback for any other/unrecognized stop_reason (e.g.
      // "stop_sequence", "pause_turn", "model_context_window_exceeded", a
      // null value, or a future value the SDK adds later that this loop
      // doesn't special-case): treat it the same as "end_turn" rather than
      // crashing or looping forever on a case with no explicit handling.
      return sanitizeForTerminal(collectText(response.content));
    }

    // The loop ran all MAX_ITERATIONS iterations and every one of them was
    // "tool_use" (any other stop_reason returns from inside the loop
    // above) — no natural exit occurred. Return whatever text happens to
    // exist on the final response; this is legitimately "" when the last
    // response was pure tool_use with no text, which is fine, not an error.
    this.trace.info(`iteration cap of ${MAX_ITERATIONS} reached without a final answer`);
    return sanitizeForTerminal(collectText(lastContent));
  }
}
