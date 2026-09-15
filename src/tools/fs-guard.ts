import { realpath } from "node:fs/promises";
import * as path from "node:path";

/**
 * Shared context every filesystem-backed tool resolves paths against: the
 * working directory relative paths are resolved from, and the list of
 * directories a resolved path must fall inside (typically the working
 * directory itself plus the skills root). Reused as-is by read-file.ts and
 * list-directory.ts in this task, and intended for git.ts (T7, to validate
 * `cwd`) and tools/index.ts (T8, to build this context once per run).
 */
export interface FsContext {
  cwd: string;
  roots: string[];
}

// Deny-listed basenames that commonly hold secrets. Matched case-insensitively
// against the final path segment only, regardless of platform — the
// resolveInside contract calls this out explicitly, unlike the root-containment
// check below, which is only case-insensitive on win32.
const DENY_EXACT_BASENAMES = new Set([".env", ".npmrc", ".netrc"]);
const DENY_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];
const DENY_PREFIXES = ["id_rsa", "id_ed25519"];

// Exported so list-directory.ts can filter deny-listed entries out of a
// listing with the exact same rule read-file.ts's resolveInside already
// enforces for content access, instead of a second, potentially-diverging
// copy of this logic.
export function isDeniedBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (DENY_EXACT_BASENAMES.has(lower)) {
    return true;
  }
  if (lower.startsWith(".env.")) {
    return true;
  }
  if (DENY_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  if (DENY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return false;
}

// A ".git" directory holds repo config/credentials (and, via hooks, a way to
// run code); refuse access to anything under one regardless of which root it
// otherwise lives inside. Matched case-insensitively for the same reason
// basenames are: a case-sensitive filesystem could otherwise be tricked with
// an oddly-cased directory name.
function hasGitSegment(resolvedPath: string): boolean {
  return resolvedPath.split(path.sep).some((segment) => segment.toLowerCase() === ".git");
}

// realpath() already resolves symlinks, short names, and (on Windows) actual
// on-disk casing, so this comparison only needs to account for two paths
// that are the "same" path spelled with different letter case — which
// win32 filesystems normally treat as equal.
function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

/**
 * Resolves `requested` to a real, on-disk absolute path and verifies it is
 * allowed to be read/listed, following the fs-guard algorithm exactly:
 *
 *  1. `path.resolve(ctx.cwd, requested)` — relative paths resolve against
 *     `ctx.cwd`; an absolute `requested` is used as-is (path.resolve's own
 *     semantics).
 *  2. `fs.realpath` the candidate. The target must actually exist and this
 *     also resolves any symlink in the path, which is what turns a
 *     symlink-escape attempt into a containment failure in the next step
 *     rather than a false "allowed".
 *  3. The realpath'd candidate must equal, or be a descendant of, the
 *     realpath'd form of at least one entry in `ctx.roots`. Compared
 *     case-insensitively on win32 (candidate and root are lowercased before
 *     comparing; the path this function returns keeps its real, original
 *     case — it is only the comparison that folds case).
 *  4. Its basename must not match the secret deny-list (.env, .env.*,
 *     *.pem, *.key, id_rsa*, id_ed25519*, .npmrc, .netrc, *.p12, *.pfx), and
 *     no path segment anywhere in the resolved path may be ".git".
 *
 * Throws a short, generic Error on any violation. The message never echoes
 * the raw OS error (which can carry sensitive path fragments) and never
 * file contents — callers (read-file.ts, list-directory.ts, and later
 * git.ts / tools/index.ts) can let it propagate unchanged as their own
 * rejection reason.
 */
export async function resolveInside(ctx: FsContext, requested: string): Promise<string> {
  const candidate = path.resolve(ctx.cwd, requested);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new Error("path does not exist or is not accessible");
  }

  let allowed = false;
  for (const root of ctx.roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      // A configured root that itself can't be resolved contributes no
      // coverage rather than aborting the whole check.
      continue;
    }
    if (isInsideRoot(real, realRoot)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    throw new Error("path is outside the allowed directories");
  }

  if (isDeniedBasename(path.basename(real))) {
    throw new Error("access to this file is not permitted");
  }
  if (hasGitSegment(real)) {
    throw new Error("access to .git internals is not permitted");
  }

  return real;
}
