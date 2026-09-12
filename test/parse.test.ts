import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  ALLOWED_FIELDS,
  parseSkillFile,
  splitFrontmatter,
  validateDescription,
  validateName,
} from "../src/skills/parse.js";

// parseSkillFile reads from disk, so each test that needs a real file writes
// one into a throwaway temp directory and cleans it up afterward.
async function withSkillFile(
  content: string,
  run: (location: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-parse-"));
  const location = path.join(dir, "SKILL.md");
  try {
    await writeFile(location, content, "utf8");
    await run(location);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function frontmatter(body: string, doc: string): string {
  return `---\n${doc}\n---\n\n${body}`;
}

test("ALLOWED_FIELDS contains exactly the six spec-recognized keys", () => {
  assert.deepEqual(
    [...ALLOWED_FIELDS].sort(),
    ["allowed-tools", "compatibility", "description", "license", "metadata", "name"].sort(),
  );
});

test("a fully valid minimal skill parses with zero diagnostics", async () => {
  const content = frontmatter(
    "Body content here.",
    "name: minimal-skill\ndescription: A minimal valid skill for testing.",
  );
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "minimal-skill");
    assert.deepEqual(diagnostics, []);
    assert.ok(skill);
    assert.equal(skill.name, "minimal-skill");
    assert.equal(skill.description, "A minimal valid skill for testing.");
    assert.equal(skill.location, location);
    assert.equal(skill.dir, path.resolve(path.dirname(location)));
    assert.deepEqual(skill.metadata, {});
    assert.equal(skill.license, undefined);
    assert.equal(skill.compatibility, undefined);
    assert.equal(skill.allowedTools, undefined);
  });
});

test("missing frontmatter (no opening \"---\") is an error and returns no skill", async () => {
  const content = "# No frontmatter\nJust markdown.\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "no-frontmatter");
    assert.equal(skill, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].level, "error");
  });
});

test("unclosed frontmatter (opening \"---\" but no closing one) is an error", async () => {
  const content = "---\nname: foo\ndescription: bar\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "unclosed");
    assert.equal(skill, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].level, "error");
  });
});

test("invalid YAML the quote-retry fallback cannot save is an error", async () => {
  // A tab used for indentation is a hard YAML error unrelated to the
  // description-quoting fallback, so the retry cannot rescue it.
  const content = "---\nname: foo\n\tdescription: bar\n---\n\nBody.\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "bad-yaml");
    assert.equal(skill, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].level, "error");
  });
});

test("frontmatter that parses to a YAML array instead of a mapping is an error", async () => {
  const content = "---\n- a\n- b\n---\n\nBody.\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "not-a-mapping");
    assert.equal(skill, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].level, "error");
  });
});

test('name "PDF-Processing" loads with a lowercase WARN', async () => {
  const content = frontmatter(
    "Body.",
    "name: PDF-Processing\ndescription: Uses uppercase letters in the name.",
  );
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "PDF-Processing");
    assert.ok(skill);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("must be lowercase")));
  });
});

test("a 65 character name loads with a length WARN", async () => {
  const longName = "a".repeat(65);
  const content = frontmatter("Body.", `name: ${longName}\ndescription: Name is too long.`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, longName);
    assert.ok(skill);
    assert.ok(
      diagnostics.some(
        (d) => d.level === "warn" && d.message.includes("exceeds") && d.message.includes("character limit"),
      ),
    );
  });
});

test('name "-pdf" loads with a leading-hyphen WARN', async () => {
  const content = frontmatter("Body.", "name: -pdf\ndescription: Starts with a hyphen.");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "-pdf");
    assert.ok(skill);
    assert.ok(
      diagnostics.some((d) => d.level === "warn" && d.message.includes("cannot start or end with a hyphen")),
    );
  });
});

test('name "pdf--x" loads with a consecutive-hyphens WARN', async () => {
  const content = frontmatter("Body.", "name: pdf--x\ndescription: Has consecutive hyphens.");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "pdf--x");
    assert.ok(skill);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("consecutive hyphens")));
  });
});

test('name "pdf_x" loads with an invalid-characters WARN', async () => {
  const content = frontmatter("Body.", "name: pdf_x\ndescription: Has an underscore.");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "pdf_x");
    assert.ok(skill);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("invalid characters")));
  });
});

test("dirName mismatch loads with a WARN mentioning the match rule", async () => {
  const content = frontmatter("Body.", "name: foo\ndescription: Name does not match its directory.");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "bar");
    assert.ok(skill);
    assert.equal(skill.name, "foo");
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("must match skill name")));
  });
});

test("a Chinese name with a matching dirName is valid with no name WARN", async () => {
  const chineseName = "你好";
  const content = frontmatter("Body.", `name: ${chineseName}\ndescription: Chinese name, Unicode letters allowed.`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, chineseName);
    assert.ok(skill);
    assert.equal(skill.name, chineseName);
    assert.deepEqual(diagnostics, []);
  });
});

test("a lowercase Russian name with a matching dirName is valid", async () => {
  const russianLower = "привет";
  const content = frontmatter("Body.", `name: ${russianLower}\ndescription: Russian lowercase name.`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, russianLower);
    assert.ok(skill);
    assert.deepEqual(diagnostics, []);
  });
});

test("an uppercase Russian name loads with a lowercase WARN", async () => {
  const upper = "ПРИВЕТ";
  const content = frontmatter("Body.", `name: ${upper}\ndescription: Russian uppercase name.`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, upper);
    assert.ok(skill);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("must be lowercase")));
  });
});

test("an NFKC-equivalent name/dirName pair that are byte-different has no dir-mismatch WARN", async () => {
  const precomposedName = "café"; // "e" with a precomposed acute accent (single code point)
  const combiningDirName = "café"; // "e" followed by a combining acute accent (two code points)
  assert.notEqual(precomposedName, combiningDirName, "sanity: the two forms must be byte-different");
  assert.equal(
    precomposedName.normalize("NFKC"),
    combiningDirName.normalize("NFKC"),
    "sanity: the two forms must be NFKC-equivalent",
  );
  const content = frontmatter("Body.", `name: ${precomposedName}\ndescription: Accented name, combining vs precomposed.`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, combiningDirName);
    assert.ok(skill);
    assert.deepEqual(diagnostics, []);
  });
});

test("missing description is an error and returns no skill", async () => {
  const content = frontmatter("Body.", "name: foo");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.equal(skill, null);
    assert.ok(diagnostics.some((d) => d.level === "error" && d.message.includes("required")));
  });
});

test("a description over 1024 characters loads with a WARN and stores the full string", async () => {
  const longDescription = "d".repeat(1025);
  const content = frontmatter("Body.", `name: foo\ndescription: ${longDescription}`);
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.description, longDescription);
    assert.equal(skill.description.length, 1025);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("1024")));
  });
});

test("compatibility over 500 characters loads with a WARN", async () => {
  const longCompatibility = "c".repeat(501);
  const content = frontmatter(
    "Body.",
    `name: foo\ndescription: Valid description.\ncompatibility: ${longCompatibility}`,
  );
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.compatibility, longCompatibility);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("500")));
  });
});

test("an unexpected top-level field loads with a WARN mentioning \"Unexpected\"", async () => {
  const content = frontmatter("Body.", "name: foo\ndescription: Valid description.\nfoo: bar");
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.ok(diagnostics.some((d) => d.level === "warn" && d.message.includes("Unexpected") && d.message.includes("foo")));
  });
});

test("allowed-tools is stored on SkillRecord.allowedTools", async () => {
  const content = frontmatter(
    "Body.",
    'name: foo\ndescription: Valid description.\nallowed-tools: "read_file"',
  );
  await withSkillFile(content, async (location) => {
    const { skill } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.allowedTools, "read_file");
  });
});

test("metadata values are coerced to strings using their literal YAML string form", async () => {
  const metadataYaml = "version: 1.0\n  count: 3";
  const content = frontmatter("Body.", `name: foo\ndescription: Valid description.\nmetadata:\n  ${metadataYaml}`);
  await withSkillFile(content, async (location) => {
    const { skill } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    // Derive the expected coercion from the yaml package itself rather than
    // assuming a literal form (a YAML 1.0 float loses its trailing zero once
    // parsed into a JS number).
    const raw = parseYaml(`version: 1.0\ncount: 3\n`) as { version: unknown; count: unknown };
    assert.equal(skill.metadata.version, String(raw.version));
    assert.equal(skill.metadata.count, String(raw.count));
    assert.equal(typeof skill.metadata.version, "string");
    assert.equal(typeof skill.metadata.count, "string");
  });
});

test("a description with an unquoted colon parses via the quote-retry fallback", async () => {
  const literalDescription = 'Use when: doing X, and "quoted" bits';
  const content = `---\nname: foo\ndescription: ${literalDescription}\n---\n\nBody.\n`;
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.description, literalDescription);
    assert.ok(!diagnostics.some((d) => d.level === "error"));
  });
});

// Regression: the quote-retry fallback must escape backslashes (before
// escaping quotes) so a literal backslash in the authored description round
// trips exactly, instead of being reinterpreted as a YAML string escape
// (e.g. a literal "\t" silently becoming a tab character) or throwing on
// sequences like "\\" / "\d".
test("a description with a backslash and an unquoted colon round-trips through the quote-retry fallback", async () => {
  const literalDescription = 'Use when: path is C:\\temp and "quoted"';
  const content = `---\nname: foo\ndescription: ${literalDescription}\n---\n\nBody.\n`;
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.description, literalDescription);
    assert.equal(skill.description.length, literalDescription.length);
    assert.deepEqual(diagnostics, []);
  });
});

test("a description with a regex-lookalike backslash escape round-trips through the quote-retry fallback", async () => {
  const literalDescription = "Use when: regex like \\d+ matches: yes";
  const content = `---\nname: foo\ndescription: ${literalDescription}\n---\n\nBody.\n`;
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "foo");
    assert.ok(skill);
    assert.equal(skill.description, literalDescription);
    assert.equal(skill.description.length, literalDescription.length);
    assert.deepEqual(diagnostics, []);
  });
});

// Regression: fs/promises.readFile(location, "utf8") does not strip a UTF-8
// byte-order-mark, so a file authored on Windows (Notepad, VS Code's
// "UTF-8 with BOM") must still parse instead of failing "Missing frontmatter".
test("a leading UTF-8 BOM followed by LF frontmatter still parses", async () => {
  const content = "\uFEFF---\nname: bom-skill\ndescription: Has a BOM before the frontmatter.\n---\n\nBody.\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "bom-skill");
    assert.deepEqual(diagnostics, []);
    assert.ok(skill);
    assert.equal(skill.name, "bom-skill");
    assert.equal(skill.description, "Has a BOM before the frontmatter.");
  });
});

test("a leading UTF-8 BOM followed by CRLF frontmatter still parses", async () => {
  const content =
    "\uFEFF---\r\nname: bom-crlf-skill\r\ndescription: Has a BOM and CRLF line endings.\r\n---\r\n\r\nBody.\r\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "bom-crlf-skill");
    assert.deepEqual(diagnostics, []);
    assert.ok(skill);
    assert.equal(skill.name, "bom-crlf-skill");
    assert.equal(skill.description, "Has a BOM and CRLF line endings.");
  });
});

test("splitFrontmatter strips a leading UTF-8 BOM before checking for the opening delimiter", () => {
  const text = "\uFEFF---\nname: foo\ndescription: bar\n---\n\nBody.\n";
  const { frontmatter: fm, body } = splitFrontmatter(text);
  assert.ok(!fm.startsWith("\uFEFF"));
  assert.ok(fm.includes("name: foo"));
  assert.equal(body, "Body.");
});

test("splitFrontmatter excludes the frontmatter block and delimiters from the body", () => {
  const text = [
    "---",
    "name: foo",
    "description: bar",
    "---",
    "",
    "# Actual Body",
    "This is the real body content.",
  ].join("\n");
  const { frontmatter: fm, body } = splitFrontmatter(text);
  assert.ok(fm.includes("name: foo"));
  assert.ok(!body.includes("---"));
  assert.ok(!body.includes("name:"));
  assert.ok(!body.includes("description:"));
  assert.ok(body.includes("Actual Body"));
  assert.ok(body.includes("This is the real body content."));
});

test("splitFrontmatter tolerates CRLF line endings", () => {
  const text = "---\r\nname: foo\r\ndescription: bar\r\n---\r\n\r\nBody text.\r\nSecond line.\r\n";
  const { frontmatter: fm, body } = splitFrontmatter(text);
  assert.ok(!fm.includes("\r"));
  assert.ok(!body.includes("\r"));
  assert.equal(fm, "name: foo\ndescription: bar");
  assert.equal(body, "Body text.\nSecond line.");
});

test("parseSkillFile succeeds on a CRLF-normalized skill file", async () => {
  const content = "---\r\nname: crlf-skill\r\ndescription: Uses CRLF line endings.\r\n---\r\n\r\nBody.\r\n";
  await withSkillFile(content, async (location) => {
    const { skill, diagnostics } = await parseSkillFile(location, "crlf-skill");
    assert.deepEqual(diagnostics, []);
    assert.ok(skill);
    assert.equal(skill.name, "crlf-skill");
    assert.equal(skill.description, "Uses CRLF line endings.");
  });
});

test("validateName reports every applicable WARN at once without short-circuiting", () => {
  const upperAndLong = "A".repeat(65);
  const diagnostics = validateName(upperAndLong, upperAndLong);
  assert.ok(diagnostics.some((d) => d.message.includes("character limit")));
  assert.ok(diagnostics.some((d) => d.message.includes("must be lowercase")));
});

test("validateName returns a single ERROR for a missing name and skips other checks", () => {
  const diagnostics = validateName("", "some-dir");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "error");
  assert.ok(diagnostics[0].message.includes("required"));
});

test("validateDescription returns a single ERROR for a missing description", () => {
  const diagnostics = validateDescription(undefined);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, "error");
  assert.ok(diagnostics[0].message.includes("required"));
});
