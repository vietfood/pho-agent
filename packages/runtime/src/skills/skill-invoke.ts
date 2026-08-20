import { Type, defineTool, type InlineExtension } from "../feature-api";
import type { AgentFeature } from "../features";

export interface AgentSkillBody {
  sourceId: string;
  skillName: string;
  markdown: string;
}

export interface AgentSkillProvider {
  loadNamedSkill(skillName: string, sourceId?: string): AgentSkillBody | undefined;
}

export const SKILL_INVOKE_FEATURE_ID = "skill-invoke";
export const SKILL_INVOKE_FEATURE_VERSION = "1.0.0";
export const READ_SKILL_TOOL_NAME = "read_skill";

export function createSkillInvokeFeature(skills: AgentSkillProvider): AgentFeature {
  return {
    id: SKILL_INVOKE_FEATURE_ID,
    version: SKILL_INVOKE_FEATURE_VERSION,
    extensionFactories: [createSkillInvokeExtension(skills)],
    expected: { extensions: 1 },
  };
}

function createSkillInvokeExtension(skills: AgentSkillProvider): InlineExtension {
  return {
    name: SKILL_INVOKE_FEATURE_ID,
    factory(pi) {
      pi.registerTool(
        defineTool({
          name: READ_SKILL_TOOL_NAME,
          label: "Read skill",
          description:
            "Load Markdown instructions for one named skill from an owner-enabled source. Use only when the owner names that skill. Do not browse or dump the catalog.",
          promptSnippet: "Load a named skill only when the owner asks for it by name.",
          promptGuidelines: [
            "Call read_skill only when the owner names a skill.",
            "Prefer a skill the owner already inserted with /.",
            "Do not list, search, or dump available skills.",
          ],
          parameters: Type.Object({
            name: Type.String({ description: "Skill directory name, for example repository-investigation" }),
            source: Type.Optional(
              Type.String({ description: "Optional source id: pho-code, codex, cursor, claude, or pi" }),
            ),
          }),
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted) {
              throw new Error("Operation aborted");
            }
            const loaded = skills.loadNamedSkill(params.name, params.source);
            if (!loaded) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No enabled skill matches that name. Insert it with / or name a skill from an enabled source.",
                  },
                ],
                details: undefined,
              };
            }
            return {
              content: [{ type: "text" as const, text: loaded.markdown }],
              details: { sourceId: loaded.sourceId, skillName: loaded.skillName },
            };
          },
        }),
      );
    },
  };
}
