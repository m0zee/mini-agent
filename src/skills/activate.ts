import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { splitFrontmatter } from "./parse.js";
import type { SkillRecord } from "./types.js";

// Depth convention (see listResourceFiles): a file directly inside the
// skill's dir is depth 0; each intervening subdirectory adds one. The spec
// for this task calls dir/a/file "depth 1" and dir/a/b/c/file "depth 3"
// (included) with dir/a/b/c/d/file ("depth 4") excluded — that numbering
// counts subdirectory levels, not files-at-dir-root, so translated into this
// depth-0-at-root convention the cutoff is: recurse into a subdirectory only
// while doing so keeps files inside it at depth <= 3.
const MAX_RESOURCE_DEPTH = 3;

// Cap on the number of <file> entries in <skill_resources>; a skill bundling
// more than this gets a single truncation note instead of flooding context.
const MAX_RESOURCE_FILES = 50;

function normalizePathForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

// Mirrors catalog.ts's escapeXmlText (element-text context: escape "&" first
// so the "&" introduced by escaping "<"/">" is never re-escaped). Duplicated
// here rather than imported: catalog.ts does not export it, and T5's scope
// is limited to this file. Used for <file> entries, which are plain XML
// element text, not attribute values.
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Attribute-value escaping is a different context from catalog.ts's element
// text: the skill name here sits inside name="...", so a literal double
// quote in the name (lenient loading allows this with only a WARN, per
// parse.ts's validateName) must also be escaped, or it terminates the
// attribute value early and produces a broken/misparseable tag.
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toPosixRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * Recursively lists files under `root` (a skill's directory), excluding
 * `excludePath` (that skill's own SKILL.md/skill.md, compared by resolved
 * path rather than basename so a case difference can't defeat the
 * exclusion). Only descends `MAX_RESOURCE_DEPTH` subdirectory levels: a
 * directory is walked into only when the files it contains would still be
 * at or under that depth, so files past the limit are never even stat'd.
 * Returns absolute paths in no particular order; the caller sorts.
 */
async function listResourceFiles(root: string, excludePath: string): Promise<string[]> {
  const excludeNormalized = normalizePathForCompare(excludePath);
  const results: string[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      // A directory that vanished or became unreadable mid-walk contributes
      // no resources rather than failing the whole activation.
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isFile()) {
        if (normalizePathForCompare(entryPath) === excludeNormalized) {
          continue;
        }
        results.push(entryPath);
      } else if (entry.isDirectory() && depth + 1 <= MAX_RESOURCE_DEPTH) {
        await walk(entryPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return results;
}

/**
 * Builds the <skill_resources> block: a sorted, depth- and count-limited
 * listing of a skill's bundled files (relative POSIX paths from its dir),
 * excluding its own frontmatter file. Files are listed, never read — tier 3
 * of progressive disclosure stays on-demand.
 */
async function renderResources(skill: SkillRecord): Promise<string> {
  const absolutePaths = await listResourceFiles(skill.dir, skill.location);
  const relativePaths = absolutePaths.map((p) => toPosixRelative(skill.dir, p)).sort();

  const shown = relativePaths.slice(0, MAX_RESOURCE_FILES);
  const lines = shown.map((rel) => `  <file>${escapeXmlText(rel)}</file>`);

  const omitted = relativePaths.length - shown.length;
  if (omitted > 0) {
    // A dedicated element (not a fake <file>) so a consumer parsing <file>
    // tags can't mistake the note for a real bundled file.
    lines.push(`  <truncated count="${omitted}"/>`);
  }

  return ["<skill_resources>", ...lines, "</skill_resources>"].join("\n");
}

/**
 * Delivers tier 2 (SKILL.md body) and the tier-3 resource listing on
 * activation, per the client-implementation guide's Step 4/5: activation is
 * model-driven (this class does no matching of its own — that's the
 * activate_skill tool's job in a later task), returns body-only content
 * wrapped for the model, and deduplicates repeat activations within one
 * instance's lifetime. State is per-instance: a new SkillActivator starts
 * with nothing active, which matters for T9's one-activator-per-agent-run
 * usage.
 */
export class SkillActivator {
  private readonly skills: Map<string, SkillRecord>;
  // Insertion-ordered set of names successfully activated so far. A Set's
  // iteration order is its insertion order, so this doubles as both the
  // dedupe check and the activeNames() ordering without a second structure.
  private readonly active = new Set<string>();

  constructor(skills: SkillRecord[]) {
    // Keyed on the raw, non-NFKC-normalized `name` field: lookups and the
    // dedupe check below both match exactly on that same raw string, per the
    // standing requirement that every module keys skills consistently.
    this.skills = new Map(skills.map((skill) => [skill.name, skill]));
  }

  activeNames(): string[] {
    return [...this.active];
  }

  async activate(name: string): Promise<string> {
    if (this.active.has(name)) {
      return `Skill "${name}" is already active in this session; follow its instructions above.`;
    }

    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Unknown skill: "${name}"`);
    }

    const text = await readFile(skill.location, "utf8");
    // splitFrontmatter (not a hand-rolled split) so the CRLF/BOM tolerance
    // T2 built in carries over automatically to tier-2 delivery.
    const { body } = splitFrontmatter(text);
    const resources = await renderResources(skill);

    this.active.add(name);

    return [
      `<skill_content name="${escapeXmlAttribute(skill.name)}">`,
      body,
      "",
      `Skill directory: ${skill.dir}`,
      "Relative paths in this skill are relative to the skill directory.",
      resources,
      "</skill_content>",
    ].join("\n");
  }
}
