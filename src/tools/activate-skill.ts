import type Anthropic from "@anthropic-ai/sdk";
import type { SkillRecord } from "../skills/types.js";

const ACTIVATE_SKILL_DESCRIPTION =
  "Loads a specific skill's full instructions by name. Call this when the user's request matches " +
  "that skill's description in the catalog above, then follow the returned instructions exactly.";

/**
 * Builds the activate_skill Anthropic.Tool definition: a required `name`
 * string constrained to an enum of exactly the given skill names, in the
 * order given. Per the client-implementation guide's Step 4 (model-driven
 * activation via a dedicated tool with an enum), this function does no
 * matching or activation itself — see skills/activate.ts's SkillActivator
 * for that — it only shapes the schema the model sees.
 *
 * Deliberately takes the already-deduped skill list as a plain parameter
 * rather than deciding on its own whether to build anything: the caller
 * (tools/index.ts's buildTools) owns the "zero skills -> omit the tool
 * entirely" decision (mirroring prompt.ts's equivalent branch for the
 * catalog), and owns deduping (dedupeSkillsByName) so the same array this
 * function reads from is also what the SkillActivator is constructed with.
 */
export function buildActivateSkillDefinition(skills: SkillRecord[]): Anthropic.Tool {
  return {
    name: "activate_skill",
    description: ACTIVATE_SKILL_DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: skills.map((skill) => skill.name),
          description: "The skill's name, exactly as listed in <available_skills>.",
        },
      },
      required: ["name"],
    },
  };
}
