import type { InlineExtension } from "./feature-api";

export interface AgentFeature {
  id: string;
  version: string;
  extensionFactories?: readonly InlineExtension[];
  extensionPaths?: readonly string[];
  skillPaths?: readonly string[];
  promptPaths?: readonly string[];
  expected?: {
    extensions?: number;
    skills?: number;
    prompts?: number;
  };
}

export function flattenAgentFeatures(features: readonly AgentFeature[]): {
  additionalExtensionPaths: string[];
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
  extensionFactories: InlineExtension[];
} {
  const additionalExtensionPaths: string[] = [];
  const additionalSkillPaths: string[] = [];
  const additionalPromptTemplatePaths: string[] = [];
  const extensionFactories: InlineExtension[] = [];
  for (const feature of features) {
    additionalExtensionPaths.push(...(feature.extensionPaths ?? []));
    additionalSkillPaths.push(...(feature.skillPaths ?? []));
    additionalPromptTemplatePaths.push(...(feature.promptPaths ?? []));
    extensionFactories.push(...(feature.extensionFactories ?? []));
  }
  return { additionalExtensionPaths, additionalSkillPaths, additionalPromptTemplatePaths, extensionFactories };
}
