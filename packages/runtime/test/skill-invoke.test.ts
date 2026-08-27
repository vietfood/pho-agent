import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  READ_SKILL_MISSING_TEXT,
  READ_SKILL_PROMPT_SNIPPET,
  READ_SKILL_TOOL_NAME,
  createSkillInvokeFeature,
  formatInvocableSkillCatalog,
  readSkillToolDescription,
  type AgentSkillCatalogEntry,
  type AgentSkillProvider,
} from "../src/skills/skill-invoke";

function fakeSkills(catalog: AgentSkillCatalogEntry[], markdown?: string): AgentSkillProvider {
  return {
    listInvocableSkills: () => catalog,
    loadNamedSkill(skillName, sourceId) {
      const match = catalog.find(
        (entry) => entry.skillName === skillName && (sourceId === undefined || entry.sourceId === sourceId),
      );
      if (!match || !markdown) {
        return undefined;
      }
      return { sourceId: match.sourceId, skillName: match.skillName, markdown };
    },
  };
}

function registeredTool(skills: AgentSkillProvider): ToolDefinition {
  let tool: ToolDefinition | undefined;
  createSkillInvokeFeature(skills).extensionFactories?.[0]?.factory({
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as never);
  if (!tool) {
    throw new Error("read_skill was not registered.");
  }
  return tool;
}

const investigation: AgentSkillCatalogEntry = {
  sourceId: "pho-code",
  skillName: "repository-investigation",
  displayName: "repository-investigation",
  description: "Trace behavior from evidence.",
};

describe("read_skill catalog", () => {
  test("lists names and descriptions without paths", () => {
    expect(formatInvocableSkillCatalog([investigation])).toContain("<name>repository-investigation</name>");
    expect(formatInvocableSkillCatalog([investigation])).toContain("Trace behavior from evidence.");
    expect(formatInvocableSkillCatalog([investigation])).not.toContain("SKILL.md");
    expect(formatInvocableSkillCatalog([])).toBe("No invocable skills are currently available.");
  });

  test("advertises the live catalog in the tool description", () => {
    const catalog = [investigation];
    const skills = fakeSkills(catalog);
    const tool = registeredTool(skills);
    expect(tool.name).toBe(READ_SKILL_TOOL_NAME);
    expect(tool.promptSnippet).toBe(READ_SKILL_PROMPT_SNIPPET);
    expect(tool.description).toBe(readSkillToolDescription(skills));
    expect(tool.description).toContain("Do not wait for the owner to insert it with /.");
    expect(tool.description).toContain("repository-investigation");
    catalog.push({
      sourceId: "cursor",
      skillName: "demo-skill",
      displayName: "demo-skill",
      description: "A compatible text-only instruction skill for tests.",
    });
    expect(tool.description).toContain("demo-skill");
  });
});

describe("read_skill execute", () => {
  test("loads a named skill without the owner inserting it", async () => {
    const tool = registeredTool(fakeSkills([investigation], "# Investigate\n"));
    const result = await tool.execute("call-1", { name: "repository-investigation" }, undefined, undefined, {} as never);
    expect(result).toEqual({
      content: [{ type: "text", text: "# Investigate\n" }],
      details: { sourceId: "pho-code", skillName: "repository-investigation" },
    });
  });

  test("returns a catalog hint when the name is unknown", async () => {
    const tool = registeredTool(fakeSkills([investigation]));
    const result = await tool.execute("call-1", { name: "test-pho-code" }, undefined, undefined, {} as never);
    expect(result).toEqual({
      content: [{ type: "text", text: READ_SKILL_MISSING_TEXT }],
      details: undefined,
    });
  });
});
