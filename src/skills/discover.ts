import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { parseSkillFile } from "./parse.js";
import type { Diagnostic, SkillRecord } from "./types.js";

// Spec cap: a SKILL.md/skill.md larger than this is rejected without being
// parsed at all, so a hostile or corrupt file can't force a large YAML/regex
// parse.
const MAX_SKILL_FILE_BYTES = 256 * 1024;

// The two accepted filenames, in preference order.
const SKILL_FILENAMES = ["SKILL.md", "skill.md"];

// Case-insensitive path comparison on win32 mirrors how Windows itself treats
// paths; realpath() already resolves case/short-name/symlink differences, so
// this only needs to guard against drive-letter casing differences.
function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

// Finds SKILL.md (preferred) or skill.md directly inside `dir`, following
// symlinks (fs.stat), and returns its stats alongside the resolved path.
// Returns undefined when neither file exists, or when `dir` is not usable as
// a directory at all (e.g. a symlink that points at a plain file) — both are
// silent skips, not diagnostics: not every directory under a skills root is
// meant to be a skill.
async function findSkillFile(dir: string): Promise<{ location: string; stats: Stats } | undefined> {
  for (const filename of SKILL_FILENAMES) {
    const candidate = path.join(dir, filename);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return { location: candidate, stats };
      }
    } catch {
      // Try the next candidate filename.
    }
  }
  return undefined;
}

/**
 * Scans `root` for skill directories: only its immediate subdirectories are
 * considered (no recursion into nested directories), each must contain a
 * SKILL.md (preferred) or skill.md directly inside it, and that file is
 * handed to parseSkillFile() from ./parse.js. Never throws: a missing root,
 * an oversized skill file, or a symlink escaping the skills root all become
 * diagnostics instead of exceptions, so a caller can always render whatever
 * was found plus whatever went wrong.
 */
export async function discoverSkills(
  root: string,
): Promise<{ skills: SkillRecord[]; diagnostics: Diagnostic[] }> {
  let rootStats: Stats;
  try {
    rootStats = await stat(root);
  } catch {
    return {
      skills: [],
      diagnostics: [{ level: "warn", message: `Skills directory "${root}" does not exist` }],
    };
  }
  if (!rootStats.isDirectory()) {
    return {
      skills: [],
      diagnostics: [{ level: "warn", message: `Skills directory "${root}" is not a directory` }],
    };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return {
      skills: [],
      diagnostics: [{ level: "warn", message: `Unable to resolve skills directory "${root}"` }],
    };
  }

  let entries;
  try {
    entries = await readdir(realRoot, { withFileTypes: true });
  } catch {
    return {
      skills: [],
      diagnostics: [{ level: "warn", message: `Unable to read skills directory "${root}"` }],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const skills: SkillRecord[] = [];

  // Bounded scan: only entries that are (or may resolve through a symlink to)
  // a directory are considered, and each is looked at exactly once — no
  // recursion past this single level.
  const subdirs = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());

  for (const entry of subdirs) {
    const dirName = entry.name;
    try {
      const entryPath = path.join(realRoot, dirName);
      const found = await findSkillFile(entryPath);
      if (!found) {
        // Not every directory under the skills root is a skill (e.g. a
        // README.md file lives beside them, or a plain notes-only folder) —
        // skip silently, no diagnostic.
        continue;
      }

      let realSkillPath: string;
      try {
        realSkillPath = await realpath(found.location);
      } catch {
        diagnostics.push({
          level: "warn",
          skill: dirName,
          message: `Unable to resolve real path of "${found.location}"`,
        });
        continue;
      }

      if (!isInsideRoot(realSkillPath, realRoot)) {
        diagnostics.push({
          level: "warn",
          skill: dirName,
          message: `Skill "${dirName}" resolves outside the skills directory and was skipped`,
        });
        continue;
      }

      if (found.stats.size > MAX_SKILL_FILE_BYTES) {
        diagnostics.push({
          level: "error",
          skill: dirName,
          message: `Skill "${dirName}" file exceeds the 256 KB size limit and was skipped`,
        });
        continue;
      }

      // dirName is passed raw (not NFKC-normalized): validateName() inside
      // parseSkillFile handles normalization itself, per the standing
      // requirement recorded for this task.
      const { skill, diagnostics: skillDiagnostics } = await parseSkillFile(realSkillPath, dirName);
      diagnostics.push(...skillDiagnostics);
      if (skill) {
        skills.push(skill);
      }
    } catch (err) {
      diagnostics.push({
        level: "warn",
        skill: dirName,
        message: `Unexpected error scanning "${dirName}": ${(err as Error).message}`,
      });
    }
  }

  // SkillRecord.name is the raw frontmatter value (not NFKC-normalized).
  // Plain `<`/`>` comparison keeps sort order deterministic across
  // environments; localeCompare's result can vary by ICU data / locale.
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { skills, diagnostics };
}
