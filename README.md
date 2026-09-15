# mini-agent

A small, read-only coding agent CLI powered by Claude Sonnet that implements the open [Agent Skills specification](https://agentskills.io/specification) and its [client-implementation guide](https://agentskills.io/client-implementation/adding-skills-support). It discovers skills under `.skills/`, discloses only their names and descriptions to the model at startup, and loads a skill's full instructions into context only when the model itself decides — via a dedicated tool call — that the user's request matches that skill. The tool surface is deliberately read-only: file reads, directory listings, and an allow-listed set of read-only `git` queries, all with real security boundaries (path containment, a secret deny-list, a git subcommand/flag allowlist, and terminal-escape sanitization) rather than defenses that only exist in the system prompt.

## Quick start

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY in .env (see .env.example)
npm start -- "I'm new to this project, what should I do?"
```

`npm start -- "<prompt>"` runs one prompt and prints the final answer to stdout. Omit the prompt to start an interactive REPL (`exit`, `quit`, or Ctrl-D to leave). In a real terminal, the REPL colors the `> ` input marker and labels each reply `Agent:` with a blank line between turns, so a back-and-forth session reads like a chat transcript instead of a wall of undifferentiated text; this is purely cosmetic (suppressed automatically when stdout is piped or redirected, so scripted/non-interactive use is unaffected) and never touches the answer text itself. `npm run build && node dist/cli.js --help` builds and runs the compiled CLI. `npm start -- --list-skills` prints discovered skills and validation diagnostics without an API key or network access.

Every error — a failed request, a bad `/skill-name` activation, an unexpected crash — is appended to `<cwd>/mini-agent-error.log` (override with `MINI_AGENT_LOG_FILE`; already covered by `.gitignore`'s `*.log` pattern, matching the project's own fixed `<cwd>/.skills` skills directory rather than a location outside the project) with a timestamp, an error type, and a stack trace, in addition to the one-line message already printed to stderr, so a problem is still traceable after the terminal window is closed. The log path itself is only ever printed at the moment an error actually occurs (a second stderr line right after the error message) — not in `--help`, which runs before any configuration is loaded and has nothing useful to say about where a not-yet-existing log file lives. A logging failure itself (e.g. an unwritable path) never masks or replaces the original error, and is never claimed as a success either — it's swallowed, and surfaced only under `--debug`.

## Demo prompts

These are the exact prompts from the assignment:

1. `"I'm new to this project, what should I do?"` — should activate `welcome-me` (stderr: `[mini-agent] skill activated: welcome-me`) and print the header from `.skills/welcome-me/SKILL.md` as the first line of stdout.
2. `"Generate a changelog for the last 5 commits"` — should activate `changelog-generator` and call the `git` tool (e.g. `git log --oneline -n 5` or similar) to build categorized release notes.
3. `"A reviewer says I should replace the yaml package with regex parsing. How should I respond?"` — should activate `receiving-code-review` and produce a verification-first, non-performative response per that skill's instructions.

Negative case (must **not** activate anything): `"what's the weather?"`. Run it with `--debug` to confirm the dumped system prompt contains the `<available_skills>` catalog but never `welcome-me`'s body text (e.g. `HARD REQUIREMENTS`), and that stderr logs no `skill activated` line.

```bash
npm start -- "I'm new to this project, what should I do?"
npm start -- "Generate a changelog for the last 5 commits"
npm start -- "A reviewer says I should replace the yaml package with regex parsing. How should I respond?"
npm start -- --debug "what's the weather?"
```

`npm run smoke` (needs `ANTHROPIC_API_KEY`) runs all four automatically via `scripts/smoke.ts` and reports PASS/WARN/SKIP per check (several checks per prompt), or a `MECHANICAL FAILURE` section instead of any checks when a prompt's subprocess times out or exits non-zero — plus a printed reminder of the three manual security spot-checks below that it deliberately does not automate.

## How skill matching works

Skill matching follows the spec's three-tier **progressive disclosure** model: no harness-side keyword or heuristic matching decides which skill applies — the only non-model activation path is the user typing an exact `/skill-name` (see the table below), everything else is a tool call the model itself chooses to make.

- **Tier 1 (always in context):** at startup, `discoverSkills` (`src/skills/discover.ts`) scans `.skills/` and `buildSystemPrompt` (`src/prompt.ts`) puts only each skill's **name and description** into the system prompt, inside an `<available_skills>` catalog rendered by `renderCatalog` (`src/skills/catalog.ts`). The **entire** system prompt is, in order: the fixed persona text ("You are mini-agent...") plus, only when at least one skill exists, one fixed behavioral paragraph (telling the model to call `activate_skill` when a task matches a skill's description) and the `<available_skills>` catalog — **nothing else from any skill** is ever in there. With zero skills, the persona text alone is returned.
- **Tier 2 (loaded only on activation):** the model calls the `activate_skill` tool (`src/tools/activate-skill.ts`, executed by `SkillActivator` in `src/skills/activate.ts`) with the skill's exact name. Only then is that skill's SKILL.md **body** (frontmatter stripped) read off disk and returned, wrapped as `<skill_content name="...">...body...\n\nSkill directory: <dir>\n...\n<skill_resources>...\n</skill_content>`, inside a `tool_result` — never in the system prompt, never pre-loaded. A repeat activation returns a short "already active" notice instead of the body again.
- **Tier 3 (read only on demand):** the `<skill_resources>` block lists a skill's bundled files (e.g. `references/guide.md`, `scripts/run.sh`) by relative path — listed, not read. The model must issue a separate `read_file` call, resolved against the "Skill directory:" line, to actually see a bundled file's contents.

**Observability:** `[mini-agent] skill activated: <name>` is always printed to stderr on a genuine first activation (never suppressed, regardless of `--debug`), from two places: `agent.ts`, for a model-driven activation, uses a positive prefix check (looking for the `<skill_content ` wrapper prefix) rather than a negative-substring check, because a skill's own name or body is allowed by lenient loading to contain the literal "already active" phrase, which would otherwise silently defeat the check; `cli.ts`'s `resolveUserMessage` emits the identical line directly for a user-explicit `/skill-name` activation, since that path never goes through `agent.ts` at all. `--debug` additionally dumps the full constructed system prompt, every intermediate assistant-turn's text, each tool call's input before it runs, and token usage, all to stderr — stdout is reserved for the final answer only.

**Mechanical proof, not just a claim:** `test/agent.test.ts` drives `Agent.run` against a stubbed Anthropic client (no network) that first returns a `tool_use` block for `activate_skill("valid-with-refs")` and then `end_turn`. The test fixture's SKILL.md body contains a literal sentinel string, `SENTINEL-BODY-TEXT-DO-NOT-LEAK`, that never appears anywhere in frontmatter, name, or description. The test asserts the sentinel is **absent from every message sent to the model before activation**, and present in **exactly one** `tool_result` afterward — a direct, automated proof of the spec's "must not be loaded into context" requirement, not something verified only by reading code. `test/catalog.test.ts` and `test/prompt.test.ts` make the companion assertion: the sentinel never appears in the rendered `<available_skills>` catalog either.

## Spec compliance

Condensed from `tasks/plan.md` §3; every path below is a real file in this repo.

| Spec/guide requirement | Implemented in | Proven by |
|---|---|---|
| Skill = directory with `SKILL.md` (prefers `SKILL.md`, falls back to `skill.md`); ignore non-skill entries | `src/skills/discover.ts` | `test/discover.test.ts` |
| Frontmatter split (`---`-delimited) and YAML mapping parse | `src/skills/parse.ts` (`splitFrontmatter`) | `test/parse.test.ts` |
| `name`: 1-64 chars, lowercase, letters/digits/hyphens, no edge/double hyphen, must equal directory name, NFKC-normalized | `src/skills/parse.ts` (`validateName`) | `test/parse.test.ts` (includes Unicode/NFKC cases) |
| `description`: 1-1024 chars, required | `src/skills/parse.ts` (`validateDescription`) | `test/parse.test.ts` |
| Optional fields (`license`, `compatibility` ≤500, `metadata`, `allowed-tools`); unexpected fields flagged | `src/skills/parse.ts` (`ALLOWED_FIELDS`) | `test/parse.test.ts` |
| Lenient loading (warn-but-load vs. error-and-skip) | `src/skills/discover.ts`, `src/skills/parse.ts` | `test/discover.test.ts` |
| Tier-1 catalog: `<available_skills>` XML, name/description/location only, HTML-escaped | `src/skills/catalog.ts` (`renderCatalog`) | `test/catalog.test.ts` |
| No skills → omit catalog, behavioral paragraph, and `activate_skill` tool entirely | `src/prompt.ts`, `src/tools/index.ts` | `test/prompt.test.ts`, `test/tools-index.test.ts` |
| Model-driven activation via a dedicated tool with an enum of valid names (not harness keyword matching) | `src/tools/activate-skill.ts` | `test/tools-index.test.ts` |
| Tier-2 delivery: body-only, `<skill_content>` wrapper, `Skill directory:`, resources listed not read; dedupe | `src/skills/activate.ts` (`SkillActivator`) | `test/activate.test.ts` |
| Tier-3: bundled files listed, not read; reading one is a separate, containment-checked call | `src/skills/activate.ts` (`<skill_resources>`) + `src/tools/read-file.ts` | `test/activate.test.ts`, `test/tools.test.ts` |
| User-explicit `/skill-name` activation | `src/cli.ts` (`resolveUserMessage`) | `test/cli.test.ts` |
| Skill body absent from every message until an `activate_skill` tool_result actually returns it | `src/agent.ts` + `src/skills/activate.ts` | `test/agent.test.ts` (sentinel proof) |
| Validation inspectable without an API key | `src/cli.ts` `--list-skills` | manual (`npm start -- --list-skills`, run with `ANTHROPIC_API_KEY` unset) |

Note on the tier-3 row above: resolving a skill's relative paths against its own directory (rather than the process cwd) is an *instruction* the model is told to follow — both in the fixed behavioral paragraph and in the "Relative paths in this skill are relative to the skill directory" line `SkillActivator.activate()` appends — not something the test suite mechanically forces. `test/tools.test.ts` proves `read_file` reads a real fixture file correctly and stays containment-checked; it does not by itself prove the model actually resolves the path against the *skill* directory it was given, which is live model behavior this sandbox cannot verify (see Limitations).

Validation and catalog rendering deliberately mirror the behavior of the official `skills-ref` reference library described in the spec sources (see `tasks/plan.md` §2.2 for the primary-source research this is based on), and several of its documented test cases (name/description boundary conditions, Unicode-name handling, escaping) were ported directly into `test/parse.test.ts` and `test/catalog.test.ts`.

Two deliberate deviations from a literal reading of the spec text, both intentional and both documented here rather than silent:

- **Unicode letters are allowed in skill names.** The spec text reads `a-z0-9`; `validateName` uses `/^[\p{L}\p{N}-]+$/u` against the NFKC-normalized name, matching the reference library's more permissive, internationalization-friendly behavior (Chinese/Russian-lowercase names load cleanly; Russian-uppercase gets a WARN for the lowercase rule, not a hard rejection for being non-ASCII).
- **Unknown/unexpected frontmatter fields are a WARN, not a hard error**, per the client-implementation guide's explicit "lenient loading" policy — the skill still loads.

## Security

**Threat model:** a local CLI that (a) loads instructions from third-party files (skills, and anything a skill or a repo file says), (b) lets an LLM choose tool calls, and (c) touches the user's filesystem and git repository while holding an API key. The mitigations below are structural — enforced in code the model cannot talk its way around — not merely instructions in the system prompt.

- **Read-only tool surface.** Only four tools exist: `read_file`, `list_directory`, `git`, `activate_skill`. There is no write tool, no arbitrary command execution, and no `node`/`npm`/`npx`/shell tool of any kind. `git` itself is restricted to an allow-listed set of read-only subcommands (`log`, `show`, `diff`, `status`, `tag`, `describe`, `rev-parse`, `shortlog`, `branch`, `ls-files`) and an allow-listed set of flags, spawned with `execFile(..., { shell: false })` and a scrubbed environment (`src/tools/git.ts`).
- **Realpath-based path containment plus a secret deny-list.** `resolveInside` (`src/tools/fs-guard.ts`) resolves a requested path, calls `fs.realpath` on it (which also resolves symlinks), and requires the result to fall inside the working directory or the skills root — case-insensitively on Windows. A basename deny-list (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `*.p12`, `*.pfx`) and a blanket `.git`-path-segment refusal apply on top of containment.
- **Runtime input validation on every tool.** Every tool checks its input's actual shape at runtime (e.g. `args` must be an array of strings, `path` must be a string) independent of the JSON schema the model sees; malformed input maps to a tool error (`is_error: true`), never a crash. Unknown tool names likewise resolve to a tool error.
- **Output caps and timeouts**, so no single tool call can blow up cost or context: 100 KB file reads, 256 KB skill files, 20 KB formatted git output (with a ~1 MB `maxBuffer` hard ceiling before that), a 15-second git timeout, 200-entry directory listings, 50-entry skill-resource listings, and a 12-iteration cap on the whole agent loop (`MAX_ITERATIONS` in `src/agent.ts`).
- **Terminal-escape-sequence sanitization applied to every string that reaches a tool result or the terminal.** `sanitizeForTerminal` (`src/text.ts`) strips ANSI/VT100 escape sequences and C0/C1 control characters (keeping `\n`/`\t`) from every tool output and every line printed to stdout/stderr — including a fix for a real ReDoS vulnerability the original version had (see Gotchas below), so this is a mitigation that was actually load-tested against hostile input, not just theoretically present.
- **The one filesystem write in this project isn't a model-accessible tool.** `src/error-log.ts` appends a sanitized entry to `<cwd>/mini-agent-error.log` on an error, purely as a harness-level debugging aid — there is no tool the model can call to trigger, redirect, or read it, so it doesn't widen the "read-only tool surface" claim above; it's the CLI logging its own failures, not something a skill or a prompt can invoke.
- **API key handling.** The key is read only from `ANTHROPIC_API_KEY` via `new Anthropic()`'s own env lookup; it is never logged, even under `--debug` (`src/trace.ts` sanitizes but never touches `process.env`); there is no `--api-key` flag, since a CLI flag's value is visible to any other process on the machine via `argv`.

**Accepted, deliberate limitations** (found and left as-is during the build — see `tasks/todo.md`'s verification log for how each was verified, not merely asserted):

- `git show`/`git diff` can surface secrets committed to history (e.g. an old commit containing a since-`.gitignore`d `.env`), because they read git's own object store directly, which is entirely outside `read_file`'s deny-list. This is inherent to shipping `show`/`diff` at all — both are spec-mandated read-only subcommands.
- Deny-listed filenames (`.env`, `id_rsa`, etc.) are still **visible** in `list_directory` output even though their contents are denied by `read_file` — the deny-list is a content-access control, not a visibility control.
- No defense against Unicode bidi-override or zero-width-character spoofing (trojan-source-style tricks): `sanitizeForTerminal`'s scope is the spec's literal C0/C1 control-character wording, not general Unicode confusable/spoofing defense.
- An unclosed TOCTOU window exists between `resolveInside`'s realpath containment check and the subsequent file read/stat — accepted as low-value to close for a single-user local CLI with no concurrent untrusted actors.

**Non-goals**, stated explicitly rather than left implicit: no OS-level sandbox or container, no per-tool-call user confirmation UI, no write tools of any kind, and skills are trusted by placement — dropping a directory into `.skills/` is treated as an explicit, local, single-user act of trust, since this is a local CLI, not a multi-tenant service.

## Design decisions

- **A dedicated `activate_skill` tool with an enum of valid names**, rather than any regex/keyword/embedding router. The client-implementation guide is explicit that activation must be model-driven; building a harness-side matcher instead would be exactly the "core skill-matching logic" the assignment asks to see implemented correctly, missed.
- **Body-only wrapping on activation, never preloading bodies into the system prompt.** This is the mechanical, code-level proof of the "not loaded into context" requirement: a skill's body physically does not exist anywhere the model can see it until an `activate_skill` tool call returns it, which is exactly what `test/agent.test.ts`'s sentinel assertions verify.
- **Final-turn-only stdout.** `Agent.run` (`src/agent.ts`) only ever returns the text of the response that produced `end_turn` (or an equivalent terminal `stop_reason`); every intermediate tool-calling turn's text goes to stderr under `--debug` only. This is what guarantees a skill's required header lands as the literal first line of stdout — a streaming or print-as-you-go design would risk a preamble sentence landing before it (see Gotchas).
- **A manual, explicit agentic loop instead of the SDK's beta tool-runner helper.** Writing the iteration/tool-execution/sequencing logic out by hand (rather than delegating to `client.beta.messages.toolRunner`) keeps that logic visible, reviewable, and directly testable against a stubbed client — which is also specifically what let the sequential-vs-concurrent tool-execution race (below) get caught and independently verified during review, and left with a committed regression test guarding it, rather than being merely asserted.

## Gotchas found

- **The assignment email quotes a header that isn't the real one.** The email says the welcome header is `> Welcome to our agent!`. The actual `.skills/welcome-me/SKILL.md` HARD REQUIREMENTS line (confirmed by reading the live file, not from memory) says:

  > Your response must include at the top "> Welcome to our Command Code assignment agent!"

  Neither string is hardcoded anywhere in `src/` or `test/`. The agent follows whatever `.skills/welcome-me/SKILL.md` says at runtime — the header is part of the tier-2 body content delivered by `SkillActivator.activate()`, which reads the file fresh every session. If a grader edits the header line in that file, the system's output changes to match without any code change, because the source of truth is the file, not a baked-in constant.
- **"Not loaded into context" is proven mechanically, not asserted.** See "How skill matching works" above — `test/agent.test.ts` and `test/catalog.test.ts` assert a sentinel string's absence/presence directly against the actual messages sent to (and returned by) a stubbed Claude client.
- **Preamble-before-header risk.** An early, more naive design that streamed tokens or printed each turn's text as it arrived would have let ordinary "Let me check that skill..." style commentary land on stdout before the required header — breaking the literal "first line of stdout" requirement. Final-turn-only stdout output (see Design decisions) avoids this by construction: nothing is written to stdout until the whole loop has already produced its one, final answer.
- **A catastrophic ReDoS in `sanitizeForTerminal`.** The original ANSI-stripping regex used an unbounded `[\s\S]*?` inside its OSC/DCS alternatives; a hostile 100 KB file caused ~5 seconds of quadratic-backtracking freeze, and a 256 KB one (the skill-file size cap) caused ~32 seconds — a real denial-of-service reachable through `read_file` and, once wired up, through any activated skill body. Fixed by excluding `ESC`/`\n` from the unbounded character classes, bringing 256 KB down to low single-digit milliseconds. During the T6 review round this was independently re-measured against a 29-case adversarial corpus with zero regressions (per `tasks/todo.md`'s verification log) — that corpus was reviewer scratch tooling, not a committed test file. The permanent, shipped regression guard is `test/tools.test.ts`'s "100 KB adversarial input of unterminated OSC starts" test, which asserts the sanitized result is correct and that it completes in well under a second.
- **`git branch <name>` and `git tag <name>` could create real refs.** The git tool's flag allowlist checked every argument starting with `-`, but never inspected bare positional arguments — and for `branch`/`tag` specifically, a bare positional means "create this ref", not "filter by pattern", unlike every other allow-listed subcommand. This silently violated the "read-only git queries" claim in the system prompt until it was closed with a rule requiring `--list` whenever `branch`/`tag` receives any positional argument.

_Time spent: [fill in]_

## Challenges

- **Getting XML-escaping context right across two different files.** `src/skills/catalog.ts`'s `escapeXmlText` is correct only for *element text* (`<name>`/`<description>`/`<location>`) and deliberately does not escape quotes. `src/skills/activate.ts` needed a genuinely different rule set for three different contexts within the same wrapper: the skill name inside `<skill_content name="...">` is an *attribute value* and needs `"` escaped too (`escapeXmlAttribute`); the SKILL.md **body** must be emitted completely verbatim/unescaped, since it's markdown/code the model needs to read exactly as authored (escaping it would corrupt code fences and break the sentinel round-trip); and the `Skill directory: <path>` line must also stay verbatim, since it's an instruction pointing the model at a real filesystem path to feed back into `read_file`. Getting this split wrong in either direction — over-escaping the body, or under-escaping the attribute — would have been a subtle, hard-to-notice bug.
- **Cross-platform frontmatter parsing fragility.** A file authored or checked out on Windows can arrive with CRLF line endings and/or a UTF-8 BOM, both of which break a literal `"---"` line match if not handled explicitly. `splitFrontmatter` strips a trailing `\r` per line and a leading BOM before ever comparing against `"---"`; a missing `.gitattributes` (fixed early, in T1) would otherwise have let git's own `core.autocrlf` silently corrupt the three shipped skill files on a fresh Windows clone.
- **Making the git tool's allowlist genuinely airtight, not just superficially safe.** Beyond the obvious subcommand/flag allowlist, closing it required thinking through indirect execution vectors: global options before the subcommand (`-c core.pager=...`), value-bearing flags that could carry shell-like content, and the branch/tag positional-argument ref-creation gap above. `execFile`'s `shell: false` closes shell-metacharacter injection, but that alone doesn't stop git itself from being turned into an execution or write vector through its own flags.
- **Proving the sequential-vs-concurrent tool-execution race was actually closed, not just claimed.** `SkillActivator.activate()` has a check-then-act race: two concurrent `activate_skill` calls for the same name (e.g. two identical tool_use blocks in one turn) could both observe "not yet active" and both return the full body. The fix is executing a turn's tool_use blocks with a sequential `for...await` loop in `src/agent.ts`, never `Promise.all`. During the T9 review round, this was verified independently with an ad hoc timing harness (artificially delayed stub tool calls shown to run with zero overlap and strictly ordered spans, per `tasks/todo.md`'s verification log) — that harness was scratch reviewer tooling, not something committed to the repo. What *does* ship as the permanent regression guard is `test/agent.test.ts`'s "two tool_use blocks in one turn" test: it sends two identical `activate_skill` calls in a single turn and asserts the second result contains the fixed "already active" notice and never the sentinel — if the race ever reopened, that second call would wrongly return the full body again and the test would fail.

## How AI was used

This project was built with a multi-agent, implement-then-adversarially-review workflow, not a single pass of "write the code and move on." For each of the 12 implementation tasks (T0's scaffold through T11's smoke script), a fresh implementer agent was given a self-contained brief scoped to exactly one task, referencing the authoritative spec documents in `tasks/`, implemented it, and self-verified with `npm run typecheck`/`npm test`. Its work was then independently re-reviewed by a **separate** senior-QA/security-reviewer agent explicitly instructed to be adversarial: re-run the implementer's own claims from scratch with fresh probes rather than trusting its report, and actively hunt for exploits, edge cases, and spec deviations. Several tasks required two review rounds before passing.

This wasn't theater — real, exploitable bugs were caught and fixed before ever reaching `main`, including:

- A **YAML-escaping bug** in the frontmatter quote-retry fallback (T2) that escaped `"` but not `\`, silently corrupting any skill description containing a backslash (e.g. a Windows path), plus a separate **UTF-8 BOM handling gap** (T2) that broke the `"---"` frontmatter delimiter check entirely on Windows-authored files.
- A **catastrophic ReDoS** in `sanitizeForTerminal` (T6) — an unbounded regex quantifier that froze the process for tens of seconds on a hostile 256 KB file, reachable through the exact tool paths (`read_file`, activated skill bodies) this project ships.
- A **git ref-creation gap** (T7): `git branch <name>`/`git tag <name>` could create real refs despite the tool being advertised as read-only, because the allowlist checked flags but never inspected bare positional arguments.
- A **race condition** (first found at T5, closed for real at T9): concurrent tool-call execution could double-deliver a skill's body and defeat activation deduplication — closed by proving, via actual timing measurement, that tool calls in a turn run strictly sequentially.
- A **silent data-loss bug** in the REPL (T10): piping multi-line input in discarded every line after the first, with a clean exit code — the worst kind of failure, since nothing visibly crashed.
- A **"vacuous pass" bug in the smoke-test script itself** (T11): pointing it at an unreachable API backend produced a false-green report on exactly the check the assignment grades hardest (must-not-load-into-context for the negative prompt), because the script never checked subprocess exit codes before evaluating pass/fail.

Every implementation task lives on its own branch, merged into `main` with `--no-ff` so the task-by-task history (and each task's fix-then-re-review cycle) stays visible in `git log`; a handful of small `chore: record T<n> merge commit hash` bookkeeping commits sit directly on `main` between merges to track progress, separate from the task branches themselves.

**No live `ANTHROPIC_API_KEY` was available during this build's automated verification.** Everything mechanical was proven either through `node:test` unit/integration tests (154 passing, no network) or by pointing the real `@anthropic-ai/sdk` at a local mock HTTP server via the `ANTHROPIC_BASE_URL` environment variable — a legitimate SDK feature — to capture real request/response wire traffic without a real key. That approach proved request routing, the tier-1/tier-2 context-disclosure boundary, error-mapping, and REPL history accumulation all work correctly end-to-end on the wire. It could **not** prove that Claude actually *selects* `welcome-me` for a newcomer prompt, drives `changelog-generator` off real git history, or fires `receiving-code-review` for review feedback — that requires a real model call. **Run the four demo prompts above once with a real `ANTHROPIC_API_KEY` before submission** to confirm live model behavior, alongside these three manual security spot-checks that `scripts/smoke.ts` explicitly calls out rather than automates:

```bash
npm start -- "read the file ../../../Windows/win.ini"
npm start -- "run git push origin main"
npm start -- "print .env"
```

(`scripts/smoke.ts` prints this same reminder with these exact three commands.)

Each should be refused by the relevant tool (path containment, the git allowlist, and the secret deny-list respectively) with no file/secret content or write actually occurring.

## Limitations

- `tsconfig.json`'s `include: ["src"]` (spec-mandated layout) means `test/` and `scripts/` are never covered by `npm run typecheck`, even though it reports green — a passing typecheck says nothing about test-file or smoke-script correctness specifically.
- `test/discover.test.ts` has a dedicated test for the lowercase `skill.md` fallback path in `src/skills/discover.ts`, and it passes — but on this case-insensitive Windows/NTFS filesystem, a lookup for `SKILL.md` always resolves to the fixture's actual `skill.md` file directly (case-insensitively), so the test never truly exercises the "try `SKILL.md`, fall through to `skill.md`" preference-order branch specifically. The fallback logic is correct by code inspection, but a case-sensitive filesystem (Linux/macOS) would be needed to exercise that exact branch.
- The REPL's `> ` prompt is written directly to stdout, so "stdout contains only the final answer" holds for one-shot mode (`npm start -- "<prompt>"`) but not for REPL mode — piping REPL output through something like `| head -1` will include prompt characters.
- No live `ANTHROPIC_API_KEY` was available during this build to verify actual model skill-selection behavior (see "How AI was used" above) — the mechanical plumbing is proven; whether Claude reliably picks the right skill for each demo prompt needs to be confirmed once, live, before submission.
