import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile as readFileFromDisk,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { sanitizeForTerminal } from "../src/text.js";
import type { FsContext } from "../src/tools/fs-guard.js";
import { listDirectory } from "../src/tools/list-directory.js";
import { readFile } from "../src/tools/read-file.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// The exact spec boundaries T6 owns: read_file's 100 KB size cap, its 8 KB
// binary-sniff window, and list_directory's 200-entry cap. Named constants
// (rather than the round numbers 101 KB / byte 6 / 250 entries used in an
// earlier draft of this suite) so the boundary tests below fail immediately
// if a future edit shifts a ">" to ">=" or 8192 to 8191.
const MAX_FILE_BYTES = 100 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LIST_ENTRIES = 200;

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- sanitizeForTerminal -----------------------------------------------------

test("sanitizeForTerminal strips a CSI sequence and an OSC sequence while preserving \\n and \\t elsewhere in the string", () => {
  const input = "start\u001b[31mred\n\ttext\u001b]0;window title\u0007end";
  const result = sanitizeForTerminal(input);
  assert.equal(result, "startred\n\ttextend");
});

test("sanitizeForTerminal handles a 100 KB adversarial input of unterminated OSC starts in well under a second (ReDoS regression)", () => {
  // Before the fix, the OSC/DCS alternatives used an unbounded, ESC/newline-
  // unaware lazy quantifier: on a string made entirely of unterminated
  // "ESC ]" starts, the engine backtracked catastrophically hunting for a
  // terminator that never comes (measured ~4.9s for 100 KB, ~32s for 256 KB
  // on the reviewer's host). 51200 repeats of the 2-character pair is
  // exactly 102400 characters (100 KB) — the same size read_file's own cap
  // allows through, so this input is realistic, not contrived.
  const adversarial = "\u001b]".repeat(51200);

  const start = performance.now();
  const result = sanitizeForTerminal(adversarial);
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 500, `expected sanitization of 100 KB to finish in well under 500ms, took ${elapsed}ms`);
  // Every "ESC ]" pair is consumed by the single-char fallback alternative
  // (no terminator ever appears), so nothing survives.
  assert.equal(result, "");
});

// --- read_file: rejections ----------------------------------------------------

test("readFile rejects a relative path that traverses outside the allowed roots", async () => {
  await withTempDir("mini-agent-tools-root-", async (root) => {
    await withTempDir("mini-agent-tools-outside-", async (outside) => {
      await writeFile(path.join(outside, "secret.txt"), "top secret", "utf8");

      const cwd = path.join(root, "a", "b");
      await mkdir(cwd, { recursive: true });
      const ctx: FsContext = { cwd, roots: [root] };

      const outsideName = path.basename(outside);
      await assert.rejects(() => readFile(`../../../${outsideName}/secret.txt`, ctx));
    });
  });
});

test("readFile rejects an absolute path that is clearly outside all provided roots", async () => {
  await withTempDir("mini-agent-tools-root-", async (root) => {
    await withTempDir("mini-agent-tools-outside-", async (outside) => {
      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "top secret", "utf8");

      const ctx: FsContext = { cwd: root, roots: [root] };
      await assert.rejects(() => readFile(outsideFile, ctx));
    });
  });
});

test("readFile rejects a path whose basename is .env even though it lives inside an allowed root", async () => {
  await withTempDir("mini-agent-tools-env-", async (root) => {
    await writeFile(path.join(root, ".env"), "SECRET=1", "utf8");
    const ctx: FsContext = { cwd: root, roots: [root] };
    await assert.rejects(() => readFile(".env", ctx));
  });
});

test("readFile rejects a path with a .git segment anywhere in it", async () => {
  await withTempDir("mini-agent-tools-git-", async (root) => {
    await mkdir(path.join(root, "something", ".git"), { recursive: true });
    await writeFile(path.join(root, "something", ".git", "config"), "[core]", "utf8");
    const ctx: FsContext = { cwd: root, roots: [root] };
    await assert.rejects(() => readFile("something/.git/config", ctx));
  });
});

// --- read_file: acceptance ----------------------------------------------------

test("readFile reads a real fixture file when the roots include the repo root, sanitized but unchanged", async () => {
  const relative = path.join("test", "fixtures", "skills", "valid-with-refs", "references", "guide.md");
  const absolute = path.join(REPO_ROOT, relative);
  const expected = await readFileFromDisk(absolute, "utf8");

  const ctx: FsContext = { cwd: REPO_ROOT, roots: [REPO_ROOT] };
  const result = await readFile(relative, ctx);

  assert.equal(result, sanitizeForTerminal(expected));
  assert.ok(result.includes("Reference material for the valid-with-refs test fixture."));
});

// --- read_file: size and binary boundaries ------------------------------------

test("readFile allows a file at exactly the 100 KB cap and refuses one byte over it", async () => {
  await withTempDir("mini-agent-tools-size-boundary-", async (root) => {
    const ctx: FsContext = { cwd: root, roots: [root] };

    await writeFile(path.join(root, "at-cap.txt"), "x".repeat(MAX_FILE_BYTES), "utf8");
    const result = await readFile("at-cap.txt", ctx);
    assert.equal(result.length, MAX_FILE_BYTES);

    await writeFile(path.join(root, "over-cap.txt"), "x".repeat(MAX_FILE_BYTES + 1), "utf8");
    await assert.rejects(() => readFile("over-cap.txt", ctx));
  });
});

test("readFile's binary sniff catches a NUL at the last byte of the 8 KB window and ignores one just past it", async () => {
  await withTempDir("mini-agent-tools-binary-boundary-", async (root) => {
    const ctx: FsContext = { cwd: root, roots: [root] };
    const fileSize = BINARY_SNIFF_BYTES + 1000; // comfortably under the 100 KB cap, well past the sniff window

    const nulAtLastSniffedByte = Buffer.alloc(fileSize, "a".charCodeAt(0));
    nulAtLastSniffedByte[BINARY_SNIFF_BYTES - 1] = 0x00;
    await writeFile(path.join(root, "nul-inside-window.dat"), nulAtLastSniffedByte);
    await assert.rejects(() => readFile("nul-inside-window.dat", ctx));

    const nulJustOutsideWindow = Buffer.alloc(fileSize, "a".charCodeAt(0));
    nulJustOutsideWindow[BINARY_SNIFF_BYTES] = 0x00;
    await writeFile(path.join(root, "nul-outside-window.dat"), nulJustOutsideWindow);
    const result = await readFile("nul-outside-window.dat", ctx);
    // Not refused as binary — but the NUL byte that slipped through the
    // sniff is still a C0 control character, so sanitizeForTerminal strips
    // it from the returned text (one character shorter than the input).
    assert.equal(result.length, fileSize - 1);
    assert.ok(!result.includes(String.fromCharCode(0)));
  });
});

// --- list_directory: cap boundary and formatting ------------------------------

test("listDirectory shows all entries with no truncation note at exactly the 200 cap, and adds one at 201", async () => {
  await withTempDir("mini-agent-tools-list-boundary-", async (root) => {
    for (let i = 0; i < MAX_LIST_ENTRIES; i++) {
      await writeFile(path.join(root, `file-${String(i).padStart(3, "0")}.txt`), "", "utf8");
    }
    const ctx: FsContext = { cwd: root, roots: [root] };

    const atCap = await listDirectory(undefined, ctx);
    const atCapLines = atCap.split("\n");
    assert.equal(atCapLines.length, MAX_LIST_ENTRIES);
    assert.ok(!atCap.includes("more entries not shown"));

    await writeFile(path.join(root, "file-200.txt"), "", "utf8");
    const overCap = await listDirectory(undefined, ctx);
    const overCapLines = overCap.split("\n");
    assert.equal(overCapLines.length, MAX_LIST_ENTRIES + 1);
    assert.equal(overCapLines[MAX_LIST_ENTRIES], "(1 more entries not shown)");
  });
});

test("listDirectory excludes .git and node_modules, and suffixes directories with / while leaving files bare", async () => {
  await withTempDir("mini-agent-tools-mixed-", async (root) => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "config"), "[core]", "utf8");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "pkg.js"), "", "utf8");
    await mkdir(path.join(root, "keepdir"));
    await writeFile(path.join(root, "keep.txt"), "hi", "utf8");

    const ctx: FsContext = { cwd: root, roots: [root] };
    const result = await listDirectory(root, ctx);
    const lines = result.split("\n");

    for (const skipped of [".git", ".git/", "node_modules", "node_modules/"]) {
      assert.ok(!lines.includes(skipped), `expected "${skipped}" to be excluded from the listing`);
    }
    assert.ok(lines.includes("keepdir/"));
    assert.ok(lines.includes("keep.txt"));
  });
});

test("listDirectory excludes every deny-listed secret filename, not just its content", async () => {
  // Mirrors fs-guard's own DENY_EXACT_BASENAMES/DENY_SUFFIXES/DENY_PREFIXES
  // set exactly, so this fails immediately if the two ever drift apart.
  // read_file already refuses these files' content; this proves a listing
  // no longer reveals that they exist at all, closing that visibility gap.
  await withTempDir("mini-agent-tools-denylist-", async (root) => {
    const denied = [".env", ".env.production", ".npmrc", ".netrc", "server.pem", "client.key", "id_rsa", "id_ed25519.pub"];
    for (const name of denied) {
      await writeFile(path.join(root, name), "secret", "utf8");
    }
    await writeFile(path.join(root, "keep.txt"), "hi", "utf8");

    const ctx: FsContext = { cwd: root, roots: [root] };
    const result = await listDirectory(root, ctx);
    const lines = result.split("\n");

    for (const name of denied) {
      assert.ok(!lines.includes(name), `expected "${name}" to be excluded from the listing`);
    }
    assert.ok(lines.includes("keep.txt"), "a non-denied file must still be listed");
  });
});

test("listDirectory's deny-list filter is case-insensitive, matching fs-guard's own check", async () => {
  await withTempDir("mini-agent-tools-denylist-case-", async (root) => {
    await writeFile(path.join(root, ".ENV"), "secret", "utf8");
    await writeFile(path.join(root, "keep.txt"), "hi", "utf8");

    const ctx: FsContext = { cwd: root, roots: [root] };
    const result = await listDirectory(root, ctx);
    const lines = result.split("\n");

    assert.ok(!lines.includes(".ENV"), 'expected ".ENV" to be excluded despite the case difference');
    assert.ok(lines.includes("keep.txt"));
  });
});

test("listDirectory excludes oddly-cased .GIT and Node_Modules directories too", async () => {
  // A separate root from the exact-case test above: NTFS (this host) is
  // case-insensitive, so ".git" and ".GIT" cannot coexist as two distinct
  // entries in the same directory -- one oddly-cased instance per name is
  // enough to prove the skip check folds case, matching fs-guard's own
  // case-insensitive ".git"-segment check.
  await withTempDir("mini-agent-tools-mixed-case-", async (root) => {
    await mkdir(path.join(root, ".GIT"));
    await mkdir(path.join(root, "Node_Modules"));
    await mkdir(path.join(root, "keepdir"));

    const ctx: FsContext = { cwd: root, roots: [root] };
    const result = await listDirectory(root, ctx);
    const lines = result.split("\n");

    for (const skipped of [".GIT", ".GIT/", "Node_Modules", "Node_Modules/"]) {
      assert.ok(!lines.includes(skipped), `expected "${skipped}" to be excluded from the listing`);
    }
    assert.ok(lines.includes("keepdir/"));
  });
});

test("listDirectory defaults to ctx.cwd when no path is given", async () => {
  await withTempDir("mini-agent-tools-default-", async (root) => {
    await writeFile(path.join(root, "only.txt"), "", "utf8");
    const ctx: FsContext = { cwd: root, roots: [root] };
    const result = await listDirectory(undefined, ctx);
    assert.equal(result, "only.txt");
  });
});

test("listDirectory rejects a resolved path that is not a directory", async () => {
  await withTempDir("mini-agent-tools-notdir-", async (root) => {
    await writeFile(path.join(root, "file.txt"), "hi", "utf8");
    const ctx: FsContext = { cwd: root, roots: [root] };
    await assert.rejects(() => listDirectory("file.txt", ctx));
  });
});

// --- symlink escape ------------------------------------------------------------

test("a symlinked directory pointing outside the allowed roots is rejected by both readFile and listDirectory", async (t) => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), "mini-agent-tools-symlink-outside-"));
  const rootDir = await mkdtemp(path.join(tmpdir(), "mini-agent-tools-symlink-root-"));
  const linkPath = path.join(rootDir, "escaped-link");
  try {
    await writeFile(path.join(outsideDir, "secret.txt"), "top secret", "utf8");

    try {
      // "junction" needs no elevated privilege on Windows; on POSIX hosts
      // fs.symlink ignores the type argument for directories.
      await symlink(outsideDir, linkPath, "junction");
    } catch {
      t.skip("symlink/junction creation is not permitted on this host");
      return;
    }

    const ctx: FsContext = { cwd: rootDir, roots: [rootDir] };
    await assert.rejects(() => readFile("escaped-link/secret.txt", ctx));
    await assert.rejects(() => listDirectory("escaped-link", ctx));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// --- malformed input -------------------------------------------------------------

test("readFile rejects a non-string path (42) cleanly instead of crashing or leaking a raw TypeError", async () => {
  const ctx: FsContext = { cwd: REPO_ROOT, roots: [REPO_ROOT] };
  await assert.rejects(() => readFile(42, ctx), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof TypeError));
    return true;
  });
});

test("listDirectory rejects a non-string path (42) cleanly instead of crashing or leaking a raw TypeError", async () => {
  const ctx: FsContext = { cwd: REPO_ROOT, roots: [REPO_ROOT] };
  await assert.rejects(() => listDirectory(42, ctx), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof TypeError));
    return true;
  });
});
