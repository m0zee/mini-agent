// Matches ANSI/VT100 escape sequences so they can be stripped before any
// third-party text (a skill body, a file's contents, model output) reaches a
// real terminal. Alternatives are ordered most-specific first so a
// well-formed sequence is consumed whole; a stray/unterminated ESC (0x1B)
// still falls through to the last, most permissive alternative rather than
// being left in the output.
const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    // CSI: ESC [ parameter-bytes(0x30-0x3F) intermediate-bytes(0x20-0x2F) final-byte(0x40-0x7E)
    // e.g. ESC[31m (set foreground color), ESC[1;37;40m, ESC[?25h
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    // OSC: ESC ] ... terminated by BEL or ESC \\ (ST). The payload class
    // excludes ESC and \\n (rather than using an unbounded [\\s\\S]*?) so an
    // unterminated OSC start fails in O(1) per starting position instead of
    // scanning to the end of the string — an unbounded lazy quantifier here
    // is a ReDoS: a large file consisting of repeated unterminated "ESC ]"
    // starts made this pattern take seconds on inputs well within the 100
    // KB/256 KB caps this codebase itself allows through read_file/SKILL.md.
    // Excluding \\n also fixes a correctness bug: an unterminated OSC no
    // longer eats legitimate text across a newline.
    // e.g. ESC]0;window title BEL
    "\\u001b\\][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)",
    // DCS / SOS / PM / APC: ESC P|X|^|_ ... terminated by ESC \\ (ST). Same
    // ReDoS/newline-safety reasoning as the OSC alternative above.
    "\\u001b[PX^_][^\\u001b\\n]*\\u001b\\\\",
    // Charset designation: ESC ( / ) / * / + / # / % followed by one byte
    // e.g. ESC(B designates ASCII as G0
    "\\u001b[()*+#%][0-9A-Za-z<=>]",
    // Any other single Fe/Fp/Fs escape sequence not matched above: ESC
    // followed by one printable ASCII byte, e.g. ESC 7/8 (save/restore
    // cursor), ESC c (full reset), ESC M/D/E (cursor movement), ESC =/>
    // (keypad mode). Also the catch-all for a truncated/malformed sequence
    // of one of the forms above: better to drop the ESC and the byte after
    // it than to leave a raw control byte in the output.
    "\\u001b[\\x20-\\x7e]",
  ].join("|"),
  "g",
);

// Remaining C0 (0x00-0x1F) and C1 (0x80-0x9F) control characters, except
// horizontal tab (0x09) and line feed (0x0A) which are preserved. This also
// mops up any lone ESC (0x1B) that the pattern above didn't consume as part
// of a recognized sequence. Built from numeric character codes (rather than
// written as literal \u escapes) so the ranges are unambiguous and easy to
// audit against the C0/C1 boundaries.
const CONTROL_CHAR_RANGES: Array<[number, number]> = [
  [0x00, 0x08], // C0 up to (but not including) \t (0x09)
  [0x0b, 0x1f], // C0 after \n (0x0a) through the end of C0, including ESC (0x1b)
  [0x80, 0x9f], // C1
];
const CONTROL_CHAR_PATTERN = new RegExp(
  "[" +
    CONTROL_CHAR_RANGES.map(([start, end]) => String.fromCharCode(start) + "-" + String.fromCharCode(end)).join("") +
    "]",
  "g",
);

/**
 * Neutralizes terminal escape-injection payloads before text is printed to
 * stdout/stderr or returned as a tool_result: strips ANSI/VT100 escape
 * sequences (CSI, OSC, and other common ESC-prefixed forms) and all
 * remaining C0/C1 control characters, except \n and \t which are preserved.
 * Does nothing else to the string — no trimming, no whitespace collapsing,
 * no Unicode normalization — so it is safe to apply unconditionally to any
 * text, trusted or not, without changing its meaning.
 */
export function sanitizeForTerminal(input: string): string {
  return input.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHAR_PATTERN, "");
}
