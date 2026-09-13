import { sanitizeForTerminal } from "./text.js";

/**
 * Stderr-only logger, prefixed "[mini-agent] ". `info` is always on;
 * `debug` is gated behind the harness's --debug flag (see createTrace).
 * Nothing in this module ever writes to stdout: stdout is reserved for the
 * final assistant answer only (agent-prompt.md non-negotiable fact #7).
 */
export interface Trace {
  info(message: string): void;
  debug(message: string): void;
}

const PREFIX = "[mini-agent] ";

/**
 * Builds a Trace that writes to stderr. Every message — info or debug — is
 * passed through sanitizeForTerminal before being written: this is the
 * caller's own log output, but debug-level messages in particular may echo
 * tool inputs/outputs that ultimately trace back to attacker-controlled
 * content (a skill body, a file's contents), so it is sanitized for defense
 * in depth rather than trusted as "our own text".
 *
 * This module must NEVER be handed process.env, an API key, or a raw
 * Anthropic client/request object to log — there is no legitimate reason a
 * log line needs any of those. That is a constraint on every future caller
 * of info()/debug(), not something this module can enforce on its own: it
 * only formats and writes whatever string it is given.
 */
export function createTrace(debugEnabled: boolean): Trace {
  function write(message: string): void {
    process.stderr.write(`${PREFIX}${sanitizeForTerminal(message)}\n`);
  }

  return {
    info(message: string): void {
      write(message);
    },
    debug(message: string): void {
      if (debugEnabled) {
        write(message);
      }
    },
  };
}
