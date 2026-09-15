import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getLogFilePath, logErrorToFile } from "../src/error-log.js";

// Isolates each test's log file under a fresh temp directory by overriding
// MINI_AGENT_LOG_FILE for the duration of the callback, restoring the
// previous value (or deleting the var entirely) afterward regardless of
// success or failure, so tests never leak env state into one another or
// into the real <cwd>/mini-agent-error.log a developer might actually have.
async function withTempLogFile(run: (logFilePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mini-agent-error-log-"));
  const logFilePath = join(dir, "nested", "error.log");
  const previous = process.env.MINI_AGENT_LOG_FILE;
  process.env.MINI_AGENT_LOG_FILE = logFilePath;
  try {
    await run(logFilePath);
  } finally {
    if (previous === undefined) {
      delete process.env.MINI_AGENT_LOG_FILE;
    } else {
      process.env.MINI_AGENT_LOG_FILE = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("getLogFilePath reflects MINI_AGENT_LOG_FILE when set", async () => {
  await withTempLogFile(async (logFilePath) => {
    assert.equal(getLogFilePath(), logFilePath);
  });
});

test("getLogFilePath defaults to a file in the current working directory when unset", () => {
  const previous = process.env.MINI_AGENT_LOG_FILE;
  delete process.env.MINI_AGENT_LOG_FILE;
  try {
    const defaultPath = getLogFilePath();
    assert.equal(defaultPath, join(process.cwd(), "mini-agent-error.log"));
  } finally {
    if (previous !== undefined) {
      process.env.MINI_AGENT_LOG_FILE = previous;
    }
  }
});

test("the default log path is resolved fresh from process.cwd() on every call, not cached", async () => {
  const previousEnv = process.env.MINI_AGENT_LOG_FILE;
  delete process.env.MINI_AGENT_LOG_FILE;
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "mini-agent-error-log-cwd-"));
  try {
    process.chdir(dir);
    assert.equal(getLogFilePath(), join(dir, "mini-agent-error.log"));
  } finally {
    process.chdir(originalCwd);
    if (previousEnv !== undefined) {
      process.env.MINI_AGENT_LOG_FILE = previousEnv;
    }
    await rm(dir, { recursive: true, force: true });
  }
  // Confirm it tracks cwd back too, not just forward.
  assert.equal(getLogFilePath(), join(originalCwd, "mini-agent-error.log"));
});

test("logErrorToFile creates the parent directory and appends a correctly formatted entry", async () => {
  await withTempLogFile(async (logFilePath) => {
    const wrote = await logErrorToFile("one-shot", new Error("boom"));
    assert.equal(wrote, true, "a successful write must resolve true, so callers know it's honest to point the user at the file");
    const content = await readFile(logFilePath, "utf8");
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[one-shot\] Error: boom\n/);
    // A real Error carries a stack; it must be present in the entry (this is
    // the whole point — a bare one-line message is already on stderr, the
    // file exists specifically to keep more than that around).
    assert.ok(content.includes("at "));
  });
});

test("logErrorToFile appends, it never overwrites a prior entry", async () => {
  await withTempLogFile(async (logFilePath) => {
    await logErrorToFile("one-shot", new Error("first"));
    await logErrorToFile("repl-turn", new Error("second"));
    const content = await readFile(logFilePath, "utf8");
    const lines = content.split("\n").filter((line) => line.startsWith("["));
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.includes("[one-shot] Error: first"));
    assert.ok(lines[1]?.includes("[repl-turn] Error: second"));
  });
});

test("logErrorToFile handles a non-Error thrown value without crashing", async () => {
  await withTempLogFile(async (logFilePath) => {
    await logErrorToFile("repl-turn", "just a string, not an Error object");
    const content = await readFile(logFilePath, "utf8");
    assert.match(content, /\[repl-turn\] string: just a string, not an Error object/);
  });
});

test("logErrorToFile sanitizes a raw ANSI escape sequence embedded in the error message", async () => {
  await withTempLogFile(async (logFilePath) => {
    // sanitizeForTerminal strips a whole recognized CSI sequence (ESC + the
    // SGR bytes that follow), not just the bare ESC byte — so this becomes
    // "redtext", not "red[31mtext[0m" with only the ESC bytes removed.
    const hostileMessage = `red${String.fromCharCode(0x1b)}[31mtext${String.fromCharCode(0x1b)}[0m`;
    await logErrorToFile("one-shot", new Error(hostileMessage));
    const content = await readFile(logFilePath, "utf8");
    assert.ok(!content.includes(String.fromCharCode(0x1b)), "expected no raw ESC byte to survive");
    assert.ok(content.includes("redtext"), "expected the visible text to survive with the CSI sequence removed");
  });
});

test("logErrorToFile never throws when the log path cannot be created (e.g. a file used as a directory component)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-agent-error-log-"));
  const blockerFile = join(dir, "blocker");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(blockerFile, "not a directory");
  // A path that requires creating a directory AT a location that is
  // already a plain file — mkdir(recursive) must fail here, and
  // logErrorToFile must swallow that failure rather than propagate it.
  const unwritablePath = join(blockerFile, "error.log");
  const previous = process.env.MINI_AGENT_LOG_FILE;
  process.env.MINI_AGENT_LOG_FILE = unwritablePath;
  try {
    let result: boolean | undefined;
    await assert.doesNotReject(async () => {
      result = await logErrorToFile("one-shot", new Error("should not throw even though logging fails"));
    });
    assert.equal(result, false, "a failed write must resolve false, not throw and not silently claim success");
  } finally {
    if (previous === undefined) {
      delete process.env.MINI_AGENT_LOG_FILE;
    } else {
      process.env.MINI_AGENT_LOG_FILE = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("logErrorToFile reports a write failure via the optional trace.debug callback, without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-agent-error-log-"));
  const blockerFile = join(dir, "blocker");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(blockerFile, "not a directory");
  const unwritablePath = join(blockerFile, "error.log");
  const previous = process.env.MINI_AGENT_LOG_FILE;
  process.env.MINI_AGENT_LOG_FILE = unwritablePath;
  const debugCalls: string[] = [];
  try {
    await logErrorToFile("one-shot", new Error("x"), { debug: (message: string) => debugCalls.push(message) });
    assert.equal(debugCalls.length, 1);
    assert.ok(debugCalls[0]?.includes("failed to write error log"));
  } finally {
    if (previous === undefined) {
      delete process.env.MINI_AGENT_LOG_FILE;
    } else {
      process.env.MINI_AGENT_LOG_FILE = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
