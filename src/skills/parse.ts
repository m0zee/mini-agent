import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Diagnostic, SkillRecord } from "./types.js";

// Frontmatter keys the spec (and the reference validator) recognizes. Anything
// else on the top-level mapping is a WARN, not an ERROR (lenient loading).
export const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

const NAME_CHARS = /^[\p{L}\p{N}-]+$/u;

// Strip a trailing \r so CRLF-checked-out files split identically to LF ones;
// the "---" comparison and the extracted frontmatter/body text both go through this.
function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// fs/promises.readFile(location, "utf8") does not strip a byte-order-mark, so
// a file authored on Windows (Notepad, or VS Code's "UTF-8 with BOM") would
// otherwise start with "﻿---" and fail the opening "---" check below.
function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Splits a SKILL.md file's raw text into its YAML frontmatter and markdown body.
 * The file must start with a "---" line; the next "---" line closes the
 * frontmatter block. Throws an Error (caught by parseSkillFile and turned into
 * an ERROR diagnostic) when the opening or closing delimiter is missing.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const lines = stripLeadingBom(text).split("\n").map(stripTrailingCr);
  if (lines[0] !== "---") {
    throw new Error('Missing frontmatter: file must start with a "---" line');
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    throw new Error('Unclosed frontmatter: no closing "---" line found');
  }
  const frontmatter = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  return { frontmatter, body };
}

// Fallback for a `description:` line whose value contains a raw, unescaped
// colon or quote that breaks naive YAML mapping parsing (e.g.
// `description: Use when: foo, "bar"`). Re-wraps the value as a double-quoted
// YAML string with backslashes and inner double quotes escaped, so a second
// parse can succeed. Backslashes MUST be escaped first: escaping `"` before
// `\` would double-escape the backslashes just inserted in front of quotes,
// and skipping backslash-escaping entirely lets a literal `\t`/`\uXXXX`/etc.
// in the authored text be reinterpreted as a YAML escape sequence by the
// retried parse — silently corrupting the description (e.g. turning a
// Windows path's `\t` into a tab character) or throwing on `\\`/`\d`.
// Returns null when no rewritable `description:` line is found.
function applyDescriptionQuoteFallback(frontmatter: string): string | null {
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => /^description:\s/.test(line));
  if (index === -1) {
    return null;
  }
  const match = lines[index].match(/^description:\s*(.*)$/);
  if (!match) {
    return null;
  }
  const value = match[1];
  if (/^".*"$/.test(value.trim()) || /^'.*'$/.test(value.trim())) {
    // Already quoted: rewrapping would not fix whatever else is broken.
    return null;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  lines[index] = `description: "${escaped}"`;
  return lines.join("\n");
}

/**
 * Validates a skill's `name` field. Checks operate on the NFKC-normalized
 * form of both `name` and `dirName`, mirroring the reference validator's
 * i18n handling; the diagnostic messages still quote the original (raw)
 * name as written in frontmatter. A missing/empty name is an ERROR and
 * short-circuits the rest of the checks; every other rule is a WARN and
 * all applicable WARNs are reported together (no short-circuiting).
 */
export function validateName(name: string, dirName: string): Diagnostic[] {
  if (!name) {
    return [{ level: "error", skill: dirName, message: "Skill name is required" }];
  }

  const diagnostics: Diagnostic[] = [];
  const normalized = name.normalize("NFKC");
  const normalizedDir = dirName.normalize("NFKC");

  if (normalized.length > 64) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `Skill name "${name}" exceeds the 64 character limit`,
    });
  }
  if (normalized !== normalized.toLowerCase()) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `Skill name "${name}" must be lowercase`,
    });
  }
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `Skill name "${name}" cannot start or end with a hyphen`,
    });
  }
  if (normalized.includes("--")) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `Skill name "${name}" contains consecutive hyphens`,
    });
  }
  if (!NAME_CHARS.test(normalized)) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `Skill name "${name}" contains invalid characters`,
    });
  }
  if (normalizedDir !== normalized) {
    diagnostics.push({
      level: "warn",
      skill: name,
      message: `The directory name "${dirName}" must match skill name "${name}"`,
    });
  }
  return diagnostics;
}

/**
 * Validates a skill's `description` field. Missing/empty is an ERROR
 * (skip the whole skill). Longer than 1024 chars is a WARN only — the
 * full, untruncated string is still stored on the record; truncation for
 * display is a catalog-rendering concern, not a parsing one.
 */
export function validateDescription(description: string | undefined): Diagnostic[] {
  if (!description) {
    return [{ level: "error", message: "Skill description is required" }];
  }
  if (description.length > 1024) {
    return [{ level: "warn", message: "Skill description exceeds the 1024 character limit" }];
  }
  return [];
}

function coerceMetadata(value: unknown): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return metadata;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    metadata[key] = String(raw);
  }
  return metadata;
}

/**
 * Reads and parses a single SKILL.md (or skill.md) file at `location`.
 * `dirName` is the name of the skill's containing directory, passed in by
 * the caller (discover.ts) rather than derived from `location`, so it can
 * be validated against the frontmatter `name` and so this function stays
 * easy to unit test in isolation.
 *
 * Returns `{ skill: null, diagnostics }` (with at least one ERROR
 * diagnostic) when the file cannot be parsed into a usable skill; the
 * caller should skip the skill entirely in that case. Otherwise returns
 * `{ skill, diagnostics }` where `diagnostics` holds zero or more WARNs.
 */
export async function parseSkillFile(
  location: string,
  dirName: string,
): Promise<{ skill: SkillRecord | null; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const text = await readFile(location, "utf8");

  let frontmatter: string;
  try {
    ({ frontmatter } = splitFrontmatter(text));
  } catch (err) {
    diagnostics.push({ level: "error", skill: dirName, message: (err as Error).message });
    return { skill: null, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    const fallback = applyDescriptionQuoteFallback(frontmatter);
    if (fallback === null) {
      diagnostics.push({ level: "error", skill: dirName, message: "Frontmatter is not valid YAML" });
      return { skill: null, diagnostics };
    }
    try {
      parsed = parseYaml(fallback);
    } catch {
      diagnostics.push({ level: "error", skill: dirName, message: "Frontmatter is not valid YAML" });
      return { skill: null, diagnostics };
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({ level: "error", skill: dirName, message: "Frontmatter must be a YAML mapping" });
    return { skill: null, diagnostics };
  }

  const data = parsed as Record<string, unknown>;

  const rawName = typeof data.name === "string" ? data.name : "";
  const nameDiagnostics = validateName(rawName, dirName);
  diagnostics.push(...nameDiagnostics);
  if (nameDiagnostics.some((d) => d.level === "error")) {
    return { skill: null, diagnostics };
  }

  const rawDescription = typeof data.description === "string" ? data.description : undefined;
  const descriptionDiagnostics = validateDescription(rawDescription);
  diagnostics.push(...descriptionDiagnostics.map((d) => ({ ...d, skill: rawName })));
  if (descriptionDiagnostics.some((d) => d.level === "error")) {
    return { skill: null, diagnostics };
  }

  const compatibility = typeof data.compatibility === "string" ? data.compatibility : undefined;
  if (compatibility !== undefined && compatibility.length > 500) {
    diagnostics.push({
      level: "warn",
      skill: rawName,
      message: `Skill "${rawName}" compatibility exceeds the 500 character limit`,
    });
  }

  const unexpectedFields = Object.keys(data).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unexpectedFields.length > 0) {
    diagnostics.push({
      level: "warn",
      skill: rawName,
      message: `Unexpected field(s) in frontmatter: ${unexpectedFields.join(", ")}`,
    });
  }

  const license = typeof data.license === "string" ? data.license : undefined;
  const allowedTools = typeof data["allowed-tools"] === "string" ? data["allowed-tools"] : undefined;
  const metadata = coerceMetadata(data.metadata);

  const skill: SkillRecord = {
    name: rawName,
    description: rawDescription as string,
    location,
    dir: path.resolve(path.dirname(location)),
    metadata,
  };
  if (license !== undefined) {
    skill.license = license;
  }
  if (compatibility !== undefined) {
    skill.compatibility = compatibility;
  }
  if (allowedTools !== undefined) {
    skill.allowedTools = allowedTools;
  }

  // The body is intentionally not part of SkillRecord: T2's contract is
  // frontmatter metadata only. A later task (activate.ts) re-reads the file
  // and calls splitFrontmatter itself to get the body for tier-2 disclosure.
  return { skill, diagnostics };
}
