import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { dedupeSkillsByName } from "../src/skills/dedupe.js";
import { discoverSkills } from "../src/skills/discover.js";
import type { SkillRecord } from "../src/skills/types.js";
import { buildTools } from "../src/tools/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");

// Matches the discovered, sorted-by-name fixture set proven by
// discover.test.ts: mismatch-dir's own frontmatter name is "other-name", not
// its directory name.
const FIXTURE_SKILL_NAMES = ["lowercase-skill-md", "other-name", "unexpected-field", "valid-with-refs"];

function makeSkill(overrides: Partial<SkillRecord> & { location: string; dir: string }): SkillRecord {
  return {
    name: "temp-skill",
    description: "A temp skill for testing.",
    metadata: {},
    ...overrides,
  };
}

// The real-git-spawn tests below guard themselves with this check and skip
// (rather than fail) when git is not runnable in the sandbox, matching
// T7's git.test.ts pattern.
function isGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- dedupeSkillsByName -------------------------------------------------------

test("dedupeSkillsByName keeps the first occurrence and warns once per duplicated name", () => {
  const first = makeSkill({ name: "dup", location: "/a/SKILL.md", dir: "/a" });
  const second = makeSkill({ name: "dup", location: "/b/SKILL.md", dir: "/b" });
  const other = makeSkill({ name: "solo", location: "/c/SKILL.md", dir: "/c" });

  const { skills, diagnostics } = dedupeSkillsByName([first, other, second]);

  assert.deepEqual(skills, [first, other]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "warn");
  assert.match(diagnostics[0].message, /dup/);
});

test("dedupeSkillsByName passes an array with no duplicates through unchanged, with no diagnostics", () => {
  const a = makeSkill({ name: "a", location: "/a/SKILL.md", dir: "/a" });
  const b = makeSkill({ name: "b", location: "/b/SKILL.md", dir: "/b" });

  const { skills, diagnostics } = dedupeSkillsByName([a, b]);

  assert.deepEqual(skills, [a, b]);
  assert.deepEqual(diagnostics, []);
});

test("dedupeSkillsByName preserves the relative order of surviving records", () => {
  const a = makeSkill({ name: "a", location: "/a/SKILL.md", dir: "/a" });
  const b = makeSkill({ name: "b", location: "/b/SKILL.md", dir: "/b" });
  const c = makeSkill({ name: "c", location: "/c/SKILL.md", dir: "/c" });
  const dupB = makeSkill({ name: "b", location: "/b2/SKILL.md", dir: "/b2" });

  const { skills } = dedupeSkillsByName([a, b, c, dupB]);

  assert.deepEqual(
    skills.map((s) => s.name),
    ["a", "b", "c"],
  );
  assert.equal(skills[1], b);
});

// --- buildTools: definitions ---------------------------------------------------

test("buildTools against the real fixtures produces exactly 4 tool definitions and a matching activate_skill enum", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { definitions, skills: builtSkills } = buildTools({
    cwd: REPO_ROOT,
    skillsRoot: FIXTURES_ROOT,
    skills,
  });

  assert.deepEqual(
    definitions.map((tool) => tool.name).sort(),
    ["activate_skill", "git", "list_directory", "read_file"].sort(),
  );

  const activateSkill = definitions.find((tool) => tool.name === "activate_skill");
  assert.ok(activateSkill);
  const schema = activateSkill.input_schema as { properties: { name: { enum: string[] } } };
  assert.deepEqual(schema.properties.name.enum, FIXTURE_SKILL_NAMES);
  assert.deepEqual(
    builtSkills.map((s) => s.name),
    FIXTURE_SKILL_NAMES,
  );
});

test("buildTools with zero skills produces exactly 3 tool definitions and no activate_skill at all", () => {
  const { definitions } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  assert.equal(definitions.length, 3);
  const names = definitions.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["git", "list_directory", "read_file"].sort());
  assert.ok(!names.includes("activate_skill"));
});

// --- buildTools: dedupe diagnostics are surfaced, not discarded -----------------

test("buildTools surfaces dedupeSkillsByName's diagnostics: a duplicated skill name produces exactly one WARN naming it", () => {
  const first = makeSkill({ name: "dup-skill", location: "/a/SKILL.md", dir: "/a" });
  const second = makeSkill({ name: "dup-skill", location: "/b/SKILL.md", dir: "/b" });

  const { skills, diagnostics } = buildTools({
    cwd: REPO_ROOT,
    skillsRoot: FIXTURES_ROOT,
    skills: [first, second],
  });

  assert.deepEqual(
    skills.map((s) => s.name),
    ["dup-skill"],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "warn");
  assert.match(diagnostics[0].message, /dup-skill/);
});

test("buildTools with no duplicate skill names produces an empty diagnostics array", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { diagnostics } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });

  assert.deepEqual(diagnostics, []);
});

// --- execute: read_file / list_directory / git ---------------------------------

test('execute("read_file", ...) reads a real fixture file when the roots include the repo root', async () => {
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const result = await execute("read_file", {
    path: "test/fixtures/skills/valid-with-refs/references/guide.md",
  });

  assert.equal(result.isError, false);
  assert.ok(result.output.includes("Reference material for the valid-with-refs test fixture."));
});

test('execute("list_directory", {}) with no path defaults to cwd', async () => {
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const result = await execute("list_directory", {});

  assert.equal(result.isError, false);
  assert.ok(result.output.includes("package.json"));
});

test('execute("git", ...) runs a real git log against this repo', async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const result = await execute("git", { args: ["log", "--oneline", "-n", "1"] });

  assert.equal(result.isError, false);
  assert.ok(result.output.startsWith("exit=0"));
});

// --- execute: activate_skill ----------------------------------------------------

test('execute("activate_skill", ...) reaches the real SkillActivator and returns the fixture body', async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });

  const result = await execute("activate_skill", { name: "valid-with-refs" });

  assert.equal(result.isError, false);
  assert.ok(result.output.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
});

test('execute("activate_skill", { name: 42 }) rejects a non-string name cleanly', async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });

  const result = await execute("activate_skill", { name: 42 });

  assert.equal(result.isError, true);
});

test('execute("activate_skill", { name: "no-such-skill" }) is an error', async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });

  const result = await execute("activate_skill", { name: "no-such-skill" });

  assert.equal(result.isError, true);
});

// --- execute: unknown tool / malformed input -------------------------------------

test('execute("nonexistent_tool", {}) is an error, not a crash', async () => {
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const result = await execute("nonexistent_tool", {});

  assert.equal(result.isError, true);
  assert.match(result.output, /nonexistent_tool/);
});

test('execute("read_file", { path: 42 }) and execute("git", { args: "not-an-array" }) are errors, not crashes', async () => {
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const readResult = await execute("read_file", { path: 42 });
  assert.equal(readResult.isError, true);

  const gitResult = await execute("git", { args: "not-an-array" });
  assert.equal(gitResult.isError, true);
});

test('execute("read_file", null) and execute("read_file", "just a string") reject malformed input itself, not crash', async () => {
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [] });

  const nullResult = await execute("read_file", null);
  assert.equal(nullResult.isError, true);

  const stringResult = await execute("read_file", "just a string");
  assert.equal(stringResult.isError, true);
});

// --- sanitizeForTerminal genuinely runs on activate_skill's output --------------

test("sanitizeForTerminal strips a raw ANSI escape from activate_skill's output (the one gap SkillActivator itself does not close)", async () => {
  await withTempDir("mini-agent-tools-index-ansi-", async (dir) => {
    // Built with String.fromCharCode (and real embedded line breaks in the
    // template literals below, not escape-sequence text) so this source
    // file contains no raw control byte and no ambiguous backslash escape
    // at all — matching the discipline settled on after a T7 review
    // finding: a raw literal control byte typed directly into a test
    // string is a real defect, not a style nit.
    const esc = String.fromCharCode(0x1b);
    const body = `before${esc}[31mred${esc}[0mafter`;
    const frontmatter = [
      "---",
      "name: ansi-skill",
      "description: A fixture skill whose body carries a raw ANSI escape.",
      "---",
      "",
      body,
    ].join(String.fromCharCode(10));
    const location = path.join(dir, "SKILL.md");
    await writeFile(location, frontmatter, "utf8");
    const skill = makeSkill({ name: "ansi-skill", location, dir });

    const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills: [skill] });
    const result = await execute("activate_skill", { name: "ansi-skill" });

    assert.equal(result.isError, false);
    assert.ok(!result.output.includes(esc), "expected no raw ESC byte to survive sanitization");
    assert.ok(result.output.includes("beforeredafter"));
  });
});

// --- same buildTools() result is reused across execute calls -------------------

test("the same SkillActivator instance is reused across execute calls: a second activation returns the already-active message", async (t) => {
  if (!(await isGitAvailable())) {
    t.skip("git is not available in this environment");
    return;
  }
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const { execute } = buildTools({ cwd: REPO_ROOT, skillsRoot: FIXTURES_ROOT, skills });

  // Two unrelated git calls through the same buildTools() result first, to
  // exercise it as a real agent run would before touching activate_skill.
  const firstGit = await execute("git", { args: ["log", "--oneline", "-n", "1"] });
  const secondGit = await execute("git", { args: ["status"] });
  assert.equal(firstGit.isError, false);
  assert.equal(secondGit.isError, false);

  const firstActivation = await execute("activate_skill", { name: "valid-with-refs" });
  assert.equal(firstActivation.isError, false);
  assert.ok(firstActivation.output.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));

  const secondActivation = await execute("activate_skill", { name: "valid-with-refs" });
  assert.equal(secondActivation.isError, false);
  assert.match(secondActivation.output, /already active/);
  assert.ok(!secondActivation.output.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
});
