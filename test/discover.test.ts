import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverSkills } from "../src/skills/discover.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures", "skills");

test("discoverSkills loads exactly the four valid fixture skills, sorted by name", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const names = skills.map((s) => s.name);

  // mismatch-dir's own frontmatter name is "other-name" (deliberately
  // different from its directory), so that is the name that should appear —
  // never the directory name itself.
  assert.deepEqual(names, ["lowercase-skill-md", "other-name", "unexpected-field", "valid-with-refs"]);
  assert.ok(!names.includes("mismatch-dir"));
});

test("discoverSkills result is sorted by name with a plain comparator", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const names = skills.map((s) => s.name);
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(names, sorted);
});

test("mismatch-dir loads with a dir-mismatch WARN and unexpected-field loads with an unexpected-field WARN", async () => {
  const { skills, diagnostics } = await discoverSkills(FIXTURES_ROOT);
  const otherName = skills.find((s) => s.name === "other-name");
  const unexpectedField = skills.find((s) => s.name === "unexpected-field");
  assert.ok(otherName);
  assert.ok(unexpectedField);
  assert.ok(
    diagnostics.some((d) => d.level === "warn" && d.message.includes("must match skill name")),
  );
  assert.ok(
    diagnostics.some((d) => d.level === "warn" && d.message.includes("Unexpected field(s)")),
  );
});

test("lowercase-skill-md loads via the skill.md fallback with zero diagnostics for itself", async () => {
  const { skills, diagnostics } = await discoverSkills(FIXTURES_ROOT);
  const skill = skills.find((s) => s.name === "lowercase-skill-md");
  assert.ok(skill);
  assert.ok(!diagnostics.some((d) => d.skill === "lowercase-skill-md"));
});

test("valid-with-refs loads and its reference/script files are on disk for a later resource-listing task", async () => {
  const { skills } = await discoverSkills(FIXTURES_ROOT);
  const skill = skills.find((s) => s.name === "valid-with-refs");
  assert.ok(skill);
  assert.equal(skill.dir, path.join(FIXTURES_ROOT, "valid-with-refs"));
});

test("no-description and bad-yaml are not loaded and each produces an ERROR diagnostic", async () => {
  const { skills, diagnostics } = await discoverSkills(FIXTURES_ROOT);
  const names = skills.map((s) => s.name);
  assert.ok(!names.includes("no-description"));
  assert.ok(!names.includes("bad-yaml"));
  assert.ok(diagnostics.some((d) => d.level === "error" && d.skill === "no-description"));
  assert.ok(diagnostics.some((d) => d.level === "error" && d.skill === "bad-yaml"));
});

test("README.md and not-a-skill/ are ignored silently: no skill and no diagnostic reference them", async () => {
  const { skills, diagnostics } = await discoverSkills(FIXTURES_ROOT);
  const names = skills.map((s) => s.name);
  assert.ok(!names.includes("README"));
  assert.ok(!names.includes("not-a-skill"));
  assert.ok(!diagnostics.some((d) => d.skill === "not-a-skill"));
  assert.ok(!diagnostics.some((d) => d.skill === "README" || d.skill === "README.md"));
  assert.ok(!diagnostics.some((d) => d.message.includes("README")));
  assert.ok(!diagnostics.some((d) => d.message.includes("not-a-skill")));
});

test("a missing skills root returns no skills and exactly one warning, without throwing", async () => {
  const missingRoot = path.join(FIXTURES_ROOT, "does-not-exist-at-all");
  const { skills, diagnostics } = await discoverSkills(missingRoot);
  assert.deepEqual(skills, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "warn");
});

test("a path that exists but is a file, not a directory, returns no skills and a warning", async () => {
  const filePath = path.join(FIXTURES_ROOT, "README.md");
  const { skills, diagnostics } = await discoverSkills(filePath);
  assert.deepEqual(skills, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "warn");
});

test("a SKILL.md larger than 256 KB is skipped with an ERROR diagnostic mentioning the size limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-discover-oversized-"));
  try {
    const skillDir = path.join(root, "oversized-skill");
    await mkdir(skillDir);
    const filler = "x".repeat(300 * 1024);
    const content = `---\nname: oversized-skill\ndescription: ${filler}\n---\n\nBody.\n`;
    await writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");

    const { skills, diagnostics } = await discoverSkills(root);
    assert.equal(skills.length, 0);
    assert.ok(
      diagnostics.some((d) => d.level === "error" && d.skill === "oversized-skill" && d.message.includes("256 KB")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory with neither SKILL.md nor skill.md is skipped silently, no diagnostic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-discover-empty-"));
  try {
    await mkdir(path.join(root, "just-a-folder"));
    await writeFile(path.join(root, "just-a-folder", "notes.txt"), "no skill here", "utf8");

    const { skills, diagnostics } = await discoverSkills(root);
    assert.deepEqual(skills, []);
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked skill directory that resolves outside the skills root is skipped with a WARN", async (t) => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), "mini-agent-outside-"));
  const rootDir = await mkdtemp(path.join(tmpdir(), "mini-agent-root-"));
  const linkPath = path.join(rootDir, "escaped-link");
  try {
    await writeFile(
      path.join(outsideDir, "SKILL.md"),
      "---\nname: escaped\ndescription: Should never be loaded through the symlink escape.\n---\n\nBody.\n",
      "utf8",
    );

    try {
      // "junction" works without elevated privileges on Windows; on POSIX
      // hosts fs.symlink ignores the type argument for directories.
      await symlink(outsideDir, linkPath, "junction");
    } catch {
      t.skip("symlink/junction creation is not permitted on this host");
      return;
    }

    const { skills, diagnostics } = await discoverSkills(rootDir);
    assert.ok(!skills.some((s) => s.name === "escaped"));
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.skill === "escaped-link"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
