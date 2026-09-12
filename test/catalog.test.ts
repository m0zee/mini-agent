import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { renderCatalog } from "../src/skills/catalog.js";
import { discoverSkills } from "../src/skills/discover.js";
import type { SkillRecord } from "../src/skills/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    name: "example-skill",
    description: "An example skill for testing.",
    location: "C:\\skills\\example-skill\\SKILL.md",
    dir: "C:\\skills\\example-skill",
    metadata: {},
    ...overrides,
  };
}

test("renderCatalog emits one <skill> block with the correct name, description, and location", () => {
  const skill = makeSkill();
  const xml = renderCatalog([skill]);

  assert.equal(xml.startsWith("<available_skills>\n<skill>\n"), true);
  assert.equal(xml.endsWith("\n</skill>\n</available_skills>"), true);
  assert.match(xml, /<name>example-skill<\/name>/);
  assert.match(xml, /<description>An example skill for testing\.<\/description>/);
  assert.ok(xml.includes(`<location>${skill.location}</location>`));
  assert.equal((xml.match(/<skill>/g) ?? []).length, 1);
});

test("renderCatalog emits multiple <skill> blocks, in the given order, wrapped once in <available_skills>", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  assert.ok(skills.length > 1, "expected multiple fixture skills to exercise ordering");

  const xml = renderCatalog(skills);

  assert.equal((xml.match(/<available_skills>/g) ?? []).length, 1);
  assert.equal((xml.match(/<\/available_skills>/g) ?? []).length, 1);
  assert.equal((xml.match(/<skill>/g) ?? []).length, skills.length);
  assert.equal((xml.match(/<\/skill>/g) ?? []).length, skills.length);

  const nameOrder = [...xml.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]);
  assert.deepEqual(
    nameOrder,
    skills.map((s) => s.name),
  );

  for (const skill of skills) {
    assert.ok(xml.includes(`<location>${skill.location}</location>`));
  }
});

test("renderCatalog HTML-escapes & < > in name and description, in the correct order (no double-escaping)", () => {
  const skill = makeSkill({
    name: "a&b",
    description: "Use <this> & that, but not <that> & this.",
  });
  const xml = renderCatalog([skill]);

  assert.ok(xml.includes("<name>a&amp;b</name>"));
  assert.ok(
    xml.includes(
      "<description>Use &lt;this&gt; &amp; that, but not &lt;that&gt; &amp; this.</description>",
    ),
  );

  // Escaping "&" first, then "<"/">" means the "&" inside "&lt;"/"&gt;" must
  // never itself get escaped into "&amp;lt;"/"&amp;gt;".
  assert.ok(!xml.includes("&amp;amp;"));
  assert.ok(!xml.includes("&amp;lt;"));
  assert.ok(!xml.includes("&amp;gt;"));

  // Strip the expected tag delimiters; nothing but escaped text should
  // remain, so no bare "<" or ">" should survive anywhere else in the output.
  const withoutTags = xml.replace(
    /<\/?(available_skills|skill|name|description|location)>/g,
    "",
  );
  assert.ok(!withoutTags.includes("<"));
  assert.ok(!withoutTags.includes(">"));
});

test("renderCatalog([]) returns the exact empty-catalog form", () => {
  assert.equal(renderCatalog([]), "<available_skills>\n</available_skills>");
});

test("renderCatalog never leaks a skill's SKILL.md body (the sentinel) into the tier-1 catalog", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const xml = renderCatalog(skills);
  assert.ok(!xml.includes("SENTINEL-BODY-TEXT-DO-NOT-LEAK"));
});
