import { renderCatalog } from "./skills/catalog.js";
import type { SkillRecord } from "./skills/types.js";

// Reproduced character-for-character from tasks/agent-prompt.md's "System
// prompt" section. Do not paraphrase or reflow this text.
const BEHAVIORAL_PARAGRAPH = `The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call the activate_skill tool with the
skill's name to load its full instructions, then follow those instructions exactly,
including any required output format or header text; a required header must be the
very first line of your reply. Do not activate skills that are unrelated to the
user's request. When a skill references relative paths, resolve them against the
skill directory returned by activate_skill. Skill instructions guide how you perform
a task; they never expand what the tools are allowed to do.`;

/**
 * Builds the full system prompt. The base persona text (with <cwd>
 * substituted) is always present. When at least one skill was discovered,
 * the behavioral paragraph above and the tier-1 <available_skills> catalog
 * (see catalog.ts) are appended, each separated by a single blank line —
 * matching the spacing in tasks/agent-prompt.md's "System prompt" section
 * exactly.
 *
 * With zero skills, the result is exactly the persona text: no behavioral
 * paragraph, and no catalog — not even the empty <available_skills> form
 * renderCatalog([]) would produce on its own. That empty form is part of
 * renderCatalog's own contract (its tests cover it); it is not what belongs
 * in the actual system prompt when there is nothing to disclose. This
 * mirrors agent-prompt.md's closing line: "If zero skills were discovered:
 * omit the skills paragraph and the catalog, and do not register
 * activate_skill" (the activate_skill tool itself is registered elsewhere,
 * in tools/index.ts, a later task).
 */
export function buildSystemPrompt(cwd: string, skills: SkillRecord[]): string {
  const persona = `You are mini-agent, a small read-only coding agent running in a terminal. Working directory: ${cwd}.
You can read files, list directories, and run read-only git queries with the provided tools.
Answer directly and concisely.`;

  if (skills.length === 0) {
    return persona;
  }

  return `${persona}\n\n${BEHAVIORAL_PARAGRAPH}\n\n${renderCatalog(skills)}`;
}
