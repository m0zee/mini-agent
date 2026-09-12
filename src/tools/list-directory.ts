import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { sanitizeForTerminal } from "../text.js";
import { resolveInside, type FsContext } from "./fs-guard.js";

// Names skipped from every listing (not descended into either, but this is
// a one-level listing to begin with so "skip" just means "omit from the
// output"): .git holds repo internals (already denied outright for
// read_file by fs-guard) and node_modules is typically enormous and never
// useful for an LLM inspecting a project's own source. Matched
// case-insensitively (entry names are lowercased before the lookup) so a
// ".GIT" or "Node_Modules" directory is skipped too, consistent with
// fs-guard's own case-insensitive ".git"-segment check.
const SKIPPED_NAMES = new Set([".git", "node_modules"]);

// Output is capped at this many entries (after the SKIPPED_NAMES filter) so
// a directory with thousands of files can't flood the model's context; the
// remainder becomes a single truncation note instead.
const MAX_ENTRIES = 200;

interface ListEntry {
  name: string;
  isDirectory: boolean;
}

// readdir's Dirent reflects the directory entry itself, not what a symlink
// points at, so a symlinked subdirectory would otherwise be reported (and
// suffixed) as a plain file. stat() follows the link to get the type an
// LLM actually cares about; a dangling symlink's stat throws, and is
// reported as a file (the safer of the two for a plain listing that isn't
// trying to enforce containment on every entry — resolveInside already
// does that for whatever path is actually requested next).
async function classify(dirPath: string, dirent: Dirent): Promise<ListEntry> {
  if (dirent.isSymbolicLink()) {
    try {
      const stats = await stat(path.join(dirPath, dirent.name));
      return { name: dirent.name, isDirectory: stats.isDirectory() };
    } catch {
      return { name: dirent.name, isDirectory: false };
    }
  }
  return { name: dirent.name, isDirectory: dirent.isDirectory() };
}

/**
 * Implements the list_directory tool: validates `requestedPath` (a string,
 * or undefined to default to `ctx.cwd`), resolves and containment/deny-list-
 * checks it via fs-guard, then lists that directory's immediate entries
 * (never recursive) as one line per entry — directories suffixed "/",
 * files with no suffix — skipping ".git" and "node_modules". Entries are
 * sorted alphabetically by name (a plain code-unit comparator, not
 * locale-aware — deterministic across environments; not spec-mandated,
 * just a documented choice) and capped at 200, with one additional,
 * visually-distinct line noting how many more were omitted when there are
 * more than that.
 *
 * Rejects (never resolves) on any failure, with a short, generic reason —
 * including fs-guard's own rejections, propagated unchanged, and a
 * resolved path that turns out not to be a directory at all.
 */
export async function listDirectory(requestedPath: unknown, ctx: FsContext): Promise<string> {
  if (requestedPath !== undefined && typeof requestedPath !== "string") {
    throw new Error("path must be a string");
  }

  const real = await resolveInside(ctx, requestedPath ?? ctx.cwd);

  let stats;
  try {
    stats = await stat(real);
  } catch {
    throw new Error("path does not exist or is not accessible");
  }
  if (!stats.isDirectory()) {
    throw new Error("path is not a directory");
  }

  let dirents: Dirent[];
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch {
    throw new Error("unable to read directory");
  }

  const visible = dirents.filter((entry) => !SKIPPED_NAMES.has(entry.name.toLowerCase()));
  const entries = await Promise.all(visible.map((entry) => classify(real, entry)));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const shown = entries.slice(0, MAX_ENTRIES);
  const lines = shown.map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name));

  const omitted = entries.length - shown.length;
  if (omitted > 0) {
    // Parenthesized and phrased as a sentence so it reads as a note, not a
    // real entry — a directory entry named exactly this is not realistic,
    // but the point is that this line is visually distinct from the plain
    // "name" / "name/" lines above it, not that it is unspoofable.
    lines.push(`(${omitted} more entries not shown)`);
  }

  return sanitizeForTerminal(lines.join("\n"));
}
