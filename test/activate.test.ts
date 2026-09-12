import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SkillActivator } from "../src/skills/activate.js";
import { discoverSkills } from "../src/skills/discover.js";
import type { SkillRecord } from "../src/skills/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");

// activate.ts reads from disk on first activation, so tests that need a
// fabricated (non-fixture) skill write one into a throwaway temp directory
// and clean it up afterward, mirroring parse.test.ts's withSkillFile.
async function withTempSkillDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-activate-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeSkill(dir: string, location: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    name: "temp-skill",
    description: "A temp skill for testing.",
    location,
    dir,
    metadata: {},
    ...overrides,
  };
}

// --- Real fixture: proves tier-2/tier-3 delivery end to end ---------------

test("activating valid-with-refs against the real fixture returns the wrapped body, directory, and resource listing", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const activator = new SkillActivator(skills);
  const result = await activator.activate("valid-with-refs");

  assert.ok(result.startsWith('<skill_content name="valid-with-refs">'));

  // The necessary complement to catalog.test.ts's proof that the sentinel is
  // ABSENT from the tier-1 catalog: it must be present once the skill is
  // actually activated.
  assert.ok(result.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));

  const expectedDir = path.join(FIXTURES_ROOT, "valid-with-refs");
  assert.ok(result.includes(`Skill directory: ${expectedDir}`));

  assert.ok(result.includes("<file>references/guide.md</file>"));
  assert.ok(result.includes("<file>scripts/run.sh</file>"));
  assert.ok(!result.includes("<file>SKILL.md</file>"));

  // Resources are listed, not read.
  assert.ok(!result.includes("Reference material for the valid-with-refs test fixture."));
  assert.ok(!result.includes("Example script for the valid-with-refs test fixture."));
});

test("activating the same name a second time returns the already-active message without repeating content", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const activator = new SkillActivator(skills);
  await activator.activate("valid-with-refs");
  const second = await activator.activate("valid-with-refs");

  assert.equal(
    second,
    'Skill "valid-with-refs" is already active in this session; follow its instructions above.',
  );
  assert.ok(!second.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
  assert.ok(!second.includes("<skill_resources>"));
});

test("activeNames reflects activated skills with no duplicates after a repeat activation", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const activator = new SkillActivator(skills);
  await activator.activate("valid-with-refs");
  await activator.activate("valid-with-refs");

  assert.deepEqual(activator.activeNames(), ["valid-with-refs"]);
});

test("activating an unknown skill name rejects", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const activator = new SkillActivator(skills);
  await assert.rejects(() => activator.activate("does-not-exist"));
});

test("a freshly constructed SkillActivator has no active skills", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const activator = new SkillActivator(skills);
  assert.deepEqual(activator.activeNames(), []);
});

test("a new SkillActivator instance does not inherit activation state from a previous instance", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const first = new SkillActivator(skills);
  await first.activate("valid-with-refs");

  const second = new SkillActivator(skills);
  assert.deepEqual(second.activeNames(), []);
  const result = await second.activate("valid-with-refs");
  assert.ok(result.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
});

// --- Attribute escaping -----------------------------------------------------

test("a skill name containing a literal double quote activates with the attribute properly escaped", async () => {
  await withTempSkillDir(async (dir) => {
    const location = path.join(dir, "SKILL.md");
    await writeFile(
      location,
      '---\nname: foo"bar\ndescription: A skill whose name contains a literal double quote.\n---\n\nBody for the quoted-name skill.\n',
      "utf8",
    );
    // Constructed directly (not via parseSkillFile): lenient name validation
    // allows a name containing '"' with only a WARN, so this is a
    // legitimately loadable SkillRecord, not an artificial edge case.
    const skill = makeSkill(dir, location, { name: 'foo"bar' });
    const activator = new SkillActivator([skill]);
    const result = await activator.activate('foo"bar');

    assert.ok(result.includes('<skill_content name="foo&quot;bar">'));

    const firstLine = result.split("\n")[0];
    const rawQuoteCount = (firstLine.match(/"/g) ?? []).length;
    assert.equal(
      rawQuoteCount,
      2,
      `expected exactly 2 raw quotes delimiting the attribute value, got line: ${firstLine}`,
    );
  });
});

// --- Resource cap ------------------------------------------------------------

test("more than 50 bundled files are capped at 50 <file> entries plus a truncation note", async () => {
  await withTempSkillDir(async (dir) => {
    const location = path.join(dir, "SKILL.md");
    await writeFile(
      location,
      "---\nname: capped-skill\ndescription: Has more than 50 bundled files.\n---\n\nBody.\n",
      "utf8",
    );
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(dir, `file-${String(i).padStart(2, "0")}.txt`), `contents ${i}`, "utf8");
    }

    const skill = makeSkill(dir, location, { name: "capped-skill" });
    const activator = new SkillActivator([skill]);
    const result = await activator.activate("capped-skill");

    const fileMatches = result.match(/<file>/g) ?? [];
    assert.equal(fileMatches.length, 50);
    assert.ok(result.includes('<truncated count="10"/>'));
  });
});

// --- Depth limit -------------------------------------------------------------

test("resources are listed through depth 3 below the skill dir and excluded past it", async () => {
  await withTempSkillDir(async (dir) => {
    const location = path.join(dir, "SKILL.md");
    await writeFile(
      location,
      "---\nname: depth-skill\ndescription: Has files at various depths.\n---\n\nBody.\n",
      "utf8",
    );
    await mkdir(path.join(dir, "a", "b", "c", "d"), { recursive: true });
    await writeFile(path.join(dir, "a", "depth1.txt"), "d1", "utf8");
    await writeFile(path.join(dir, "a", "b", "depth2.txt"), "d2", "utf8");
    await writeFile(path.join(dir, "a", "b", "c", "depth3.txt"), "d3", "utf8");
    await writeFile(path.join(dir, "a", "b", "c", "d", "depth4.txt"), "d4", "utf8");

    const skill = makeSkill(dir, location, { name: "depth-skill" });
    const activator = new SkillActivator([skill]);
    const result = await activator.activate("depth-skill");

    assert.ok(result.includes("<file>a/depth1.txt</file>"));
    assert.ok(result.includes("<file>a/b/depth2.txt</file>"));
    assert.ok(result.includes("<file>a/b/c/depth3.txt</file>"));
    assert.ok(!result.includes("depth4.txt"));
  });
});

// --- Zero resources -----------------------------------------------------------

test("a skill with only a SKILL.md produces an empty <skill_resources> block", async () => {
  await withTempSkillDir(async (dir) => {
    const location = path.join(dir, "SKILL.md");
    await writeFile(
      location,
      "---\nname: lonely-skill\ndescription: Ships no bundled files.\n---\n\nBody.\n",
      "utf8",
    );

    const skill = makeSkill(dir, location, { name: "lonely-skill" });
    const activator = new SkillActivator([skill]);
    const result = await activator.activate("lonely-skill");

    assert.ok(result.includes("<skill_resources>\n</skill_resources>"));
  });
});

// --- CRLF tolerance (via splitFrontmatter reuse) -------------------------------

test("a CRLF-normalized SKILL.md activates with a clean body (no stray \\r)", async () => {
  await withTempSkillDir(async (dir) => {
    const location = path.join(dir, "SKILL.md");
    const content =
      "---\r\nname: crlf-skill\r\ndescription: Uses CRLF line endings.\r\n---\r\n\r\nBody line one.\r\nBody line two.\r\n";
    await writeFile(location, content, "utf8");

    const skill = makeSkill(dir, location, { name: "crlf-skill" });
    const activator = new SkillActivator([skill]);
    const result = await activator.activate("crlf-skill");

    assert.ok(!result.includes("\r"));
    assert.ok(result.includes("Body line one.\nBody line two."));
  });
});
