import type { Diagnostic, SkillRecord } from "./types.js";

/**
 * Dedupes skill records by name, first-occurrence-wins: whichever record for
 * a given `name` appears earliest in `skills` survives, and every later
 * record sharing that same name is discarded. This closes a real gap found
 * during T3/T5 review: a skill directory reachable twice under the skills
 * root (e.g. via a Windows junction pointing at another in-root skill
 * directory) currently produces two SkillRecords with the same name, which
 * would otherwise become duplicate values in the activate_skill tool's
 * `enum` — a malformed JSON schema.
 *
 * One WARN diagnostic is emitted per name that had at least one duplicate
 * discarded (not one per discarded record), and the relative order of the
 * surviving (first-occurrence) records is preserved.
 *
 * Per the standing requirement this closes: this function must be called
 * EXACTLY ONCE per session by whoever composes the final skill list
 * (tools/index.ts's buildTools), and that same resulting array must be
 * reused both for the catalog/system-prompt and for the activate_skill
 * enum/SkillActivator — never deduped a second time, potentially by
 * different logic, by a downstream caller.
 */
export function dedupeSkillsByName(skills: SkillRecord[]): { skills: SkillRecord[]; diagnostics: Diagnostic[] } {
  const seen = new Set<string>();
  const survivors: SkillRecord[] = [];
  const duplicateNames: string[] = [];

  for (const skill of skills) {
    if (seen.has(skill.name)) {
      if (!duplicateNames.includes(skill.name)) {
        duplicateNames.push(skill.name);
      }
      continue;
    }
    seen.add(skill.name);
    survivors.push(skill);
  }

  const diagnostics: Diagnostic[] = duplicateNames.map((name) => ({
    level: "warn",
    skill: name,
    message: `Duplicate skill name "${name}" was discovered more than once; the duplicate was ignored`,
  }));

  return { skills: survivors, diagnostics };
}
