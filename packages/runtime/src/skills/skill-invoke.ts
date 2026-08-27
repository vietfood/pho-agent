import { Type, defineTool, type InlineExtension } from "../feature-api";
import type { AgentFeature } from "../features";

export interface AgentSkillBody {
  sourceId: string;
  skillName: string;
  markdown: string;
}

export interface AgentSkillCatalogEntry {
  sourceId: string;
  skillName: string;
  displayName: string;
  description?: string;
}

export interface AgentSkillProvider {
  loadNamedSkill(skillName: string, sourceId?: string): AgentSkillBody | undefined;
  listInvocableSkills(): readonly AgentSkillCatalogEntry[];
}

export const SKILL_INVOKE_FEATURE_ID = "skill-invoke";
export const SKILL_INVOKE_FEATURE_VERSION = "1.0.0";
export const READ_SKILL_TOOL_NAME = "read_skill";
export const READ_SKILL_PROMPT_SNIPPET = "Load a named skill when the current task matches its description.";
export const READ_SKILL_PROMPT_GUIDELINES = [
  "Call read_skill when a listed skill matches the current task.",
  "Do not wait for the owner to name or insert the skill.",
  "Skip read_skill when the owner already inserted that skill with /.",
  "Load one skill at a time. Do not dump the catalog.",
] as const;
export const READ_SKILL_MISSING_TEXT =
  "No enabled skill matches that name. Use a name from available_skills, or insert the skill with /.";

export function formatInvocableSkillCatalog(skills: readonly AgentSkillCatalogEntry[]): string {
  if (skills.length === 0) {
    return "No invocable skills are currently available.";
  }
  const lines = ["<available_skills>"];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.skillName)}</name>`);
    if (skill.description) {
      lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function readSkillToolDescription(skills: AgentSkillProvider): string {
  return [
    "Load Markdown instructions for one named skill from an owner-enabled source. Call this when the current task matches a skill description. Do not wait for the owner to insert it with /.",
    formatInvocableSkillCatalog(skills.listInvocableSkills()),
  ].join("\n\n");
}

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
          // Pi reads description when composing the tool prompt, so a getter
          // keeps Refresh skills live without re-registering the tool.
          get description() {
            return readSkillToolDescription(skills);
          },
          promptSnippet: READ_SKILL_PROMPT_SNIPPET,
          promptGuidelines: [...READ_SKILL_PROMPT_GUIDELINES],
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
                content: [{ type: "text" as const, text: READ_SKILL_MISSING_TEXT }],
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
