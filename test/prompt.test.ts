import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { discoverSkills } from "../src/skills/discover.js";
import { buildSystemPrompt } from "../src/prompt.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");

test("buildSystemPrompt with real discovered skills includes the behavioral paragraph and the catalog, and never the sentinel", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  assert.ok(skills.length > 0, "expected fixtures to yield at least one valid skill");

  const prompt = buildSystemPrompt("/some/cwd", skills);

  assert.ok(prompt.includes("call the activate_skill tool with the"));
  assert.ok(prompt.includes("<available_skills>"));
  for (const skill of skills) {
    assert.ok(prompt.includes(`<name>${skill.name}</name>`));
  }
  assert.ok(!prompt.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
});

test("buildSystemPrompt with zero skills omits the skills paragraph, activate_skill, and the catalog entirely", () => {
  const prompt = buildSystemPrompt("/some/cwd", []);

  assert.ok(!prompt.includes("activate_skill"));
  assert.ok(!prompt.includes("<available_skills>"));
  assert.ok(!prompt.includes("The following skills provide specialized instructions"));
  assert.equal(
    prompt,
    "You are mini-agent, a small read-only coding agent running in a terminal. Working directory: /some/cwd.\n" +
      "You can read files, list directories, and run read-only git queries with the provided tools.\n" +
      "Answer directly and concisely.",
  );
});

test("buildSystemPrompt substitutes the given cwd argument into the persona text", () => {
  const prompt = buildSystemPrompt("D:\\laragon\\www\\mini-agent", []);
  assert.ok(prompt.includes("Working directory: D:\\laragon\\www\\mini-agent."));
});
