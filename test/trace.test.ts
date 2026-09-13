import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrace } from "../src/trace.js";

// Captures process.stderr.write calls for the duration of `run`, restoring
// the original afterward even if `run` throws. Returns every chunk written,
// as strings, in order — this module never writes to stdout, so stdout is
// not touched here at all.
async function captureStderr(run: () => void): Promise<string[]> {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return chunks;
}

test("info() always writes to stderr with the [mini-agent] prefix and a trailing newline, regardless of debugEnabled", async () => {
  for (const debugEnabled of [false, true]) {
    const trace = createTrace(debugEnabled);
    const chunks = await captureStderr(() => trace.info("hello world"));
    assert.deepEqual(chunks, ["[mini-agent] hello world\n"]);
  }
});

test("debug() is a no-op when debugEnabled is false", async () => {
  const trace = createTrace(false);
  const chunks = await captureStderr(() => trace.debug("should not appear"));
  assert.deepEqual(chunks, []);
});

test("debug() writes to stderr with the same prefix/newline as info() when debugEnabled is true", async () => {
  const trace = createTrace(true);
  const chunks = await captureStderr(() => trace.debug("verbose detail"));
  assert.deepEqual(chunks, ["[mini-agent] verbose detail\n"]);
});

test("info() and debug() both run their message through sanitizeForTerminal before writing", async () => {
  // Built with String.fromCharCode, never a literal escape byte typed into
  // this source file, per this project's own convention for these payloads.
  const esc = String.fromCharCode(0x1b);
  const dirty = `before${esc}[31mred${esc}[0mafter`;

  const infoTrace = createTrace(false);
  const infoChunks = await captureStderr(() => infoTrace.info(dirty));
  assert.equal(infoChunks.length, 1);
  assert.ok(!infoChunks[0].includes(esc), "info() must not let a raw ESC byte reach stderr");
  assert.equal(infoChunks[0], "[mini-agent] beforeredafter\n");

  const debugTrace = createTrace(true);
  const debugChunks = await captureStderr(() => debugTrace.debug(dirty));
  assert.equal(debugChunks.length, 1);
  assert.ok(!debugChunks[0].includes(esc), "debug() must not let a raw ESC byte reach stderr");
  assert.equal(debugChunks[0], "[mini-agent] beforeredafter\n");
});

test("multiple info() calls each produce their own separate, correctly prefixed line", async () => {
  const trace = createTrace(false);
  const chunks = await captureStderr(() => {
    trace.info("first");
    trace.info("second");
  });
  assert.deepEqual(chunks, ["[mini-agent] first\n", "[mini-agent] second\n"]);
});
