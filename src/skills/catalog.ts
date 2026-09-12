import type { SkillRecord } from "./types.js";

// HTML-escape order matters: "&" must be escaped first, or the "&" that
// escaping "<"/">" inserts (as "&lt;"/"&gt;") would itself get escaped a
// second time on a later pass. Quotes ("/') are deliberately NOT escaped:
// name/description/location are rendered here as XML element text content,
// never as an attribute value, so there is no attribute-quote-breakout risk
// that would call for escaping them.
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The spec's own description length limit (mirrored by parse.ts's
// validateDescription, which only WARNs past this point and keeps the full,
// untruncated string on SkillRecord).
const DESCRIPTION_DISPLAY_LIMIT = 1024;

// Decision: where the >1024-char truncation happens. parse.ts stores the
// full, untruncated description and only WARNs past the limit — its own
// comment says display truncation "is a catalog-rendering concern, not a
// parsing one", and agent-prompt.md's parsing rules make the same split
// explicit ("description > 1024 -> WARN and truncate for the catalog"). So
// this function truncates the copy that goes into the rendered catalog only;
// SkillRecord.description itself is never mutated. No ellipsis/marker is
// appended after the cut — none is specified by the spec or by any reference
// material available in this repo, and inventing one would be unsupported
// behavior.
function displayDescription(description: string): string {
  return description.length > DESCRIPTION_DISPLAY_LIMIT
    ? description.slice(0, DESCRIPTION_DISPLAY_LIMIT)
    : description;
}

/**
 * Renders the tier-1 skill catalog: for each given skill, its name,
 * description, and SKILL.md location, wrapped in <available_skills>. Skills
 * are emitted in the order given — the caller (discoverSkills) already sorts
 * by name, so this function does no sorting or filtering of its own. A
 * skill's body is never referenced here: that is tier 2, delivered only
 * through activate_skill (see activate.ts, a later task).
 *
 * Zero skills renders the empty-catalog form used by both this function's
 * own contract and its tests. buildSystemPrompt (prompt.ts) does NOT call
 * this for an empty skill list — with zero skills the system prompt omits
 * the catalog (and the skills paragraph) entirely, per the spec's guidance
 * to omit both when there is nothing to disclose.
 */
export function renderCatalog(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return "<available_skills>\n</available_skills>";
  }

  const blocks = skills.map((skill) => {
    // skill.location is already an absolute path (parse.ts resolves it), so
    // it should never contain "&"/"<"/">" in practice. It is escaped here
    // anyway, the same way as name/description: reference behavior for this
    // element specifically isn't independently verifiable from the material
    // available in this repo, so consistent escaping was chosen over
    // guessing at an unconfirmed reference quirk.
    return [
      "<skill>",
      `<name>${escapeXmlText(skill.name)}</name>`,
      `<description>${escapeXmlText(displayDescription(skill.description))}</description>`,
      `<location>${escapeXmlText(skill.location)}</location>`,
      "</skill>",
    ].join("\n");
  });

  return ["<available_skills>", ...blocks, "</available_skills>"].join("\n");
}
