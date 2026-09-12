import { readFile as readFileBytes, stat } from "node:fs/promises";
import { sanitizeForTerminal } from "../text.js";
import { resolveInside, type FsContext } from "./fs-guard.js";

// Spec cap: a file larger than this is refused before its content is ever
// read into memory (fs.stat is checked first, same ordering discipline as
// the SKILL.md size cap in discover.ts).
const MAX_FILE_BYTES = 100 * 1024;

// How much of a file's start is inspected for a NUL byte to decide it is
// binary. Rather than a separate partial read for the sniff and a second
// full read for the content, the whole (already capped to <= 100 KB) file
// is read once and this many bytes are sliced off the front of that same
// buffer for the check — one disk read either way, and simpler than
// re-opening the file.
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Implements the read_file tool: validates `requestedPath` is a string,
 * resolves and containment/deny-list-checks it via fs-guard, refuses files
 * over 100 KB or that look binary (a NUL byte in the first 8 KB), and runs
 * the result through sanitizeForTerminal before returning it — the point
 * where a hostile file's terminal-escape payload is neutralized before it
 * can ever reach a tool_result.
 *
 * Rejects (never resolves) on any failure, with a short, generic reason and
 * no file content in the error — including fs-guard's own rejections,
 * which are propagated unchanged.
 */
export async function readFile(requestedPath: unknown, ctx: FsContext): Promise<string> {
  if (typeof requestedPath !== "string") {
    throw new Error("path must be a string");
  }

  const real = await resolveInside(ctx, requestedPath);

  let stats;
  try {
    stats = await stat(real);
  } catch {
    throw new Error("path does not exist or is not accessible");
  }
  if (!stats.isFile()) {
    throw new Error("path is not a regular file");
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error("file is too large to read (over 100 KB)");
  }

  let buffer;
  try {
    buffer = await readFileBytes(real);
  } catch {
    throw new Error("unable to read file");
  }

  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) {
    throw new Error("file appears to be binary and cannot be read");
  }

  return sanitizeForTerminal(buffer.toString("utf8"));
}
