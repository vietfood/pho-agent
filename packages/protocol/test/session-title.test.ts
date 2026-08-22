import { describe, expect, test } from "bun:test";
import {
  deriveSessionTitle,
  parseGeneratedSessionTitle,
  sessionCatalogCopy,
  sessionPromptPreview,
  wrapSkillBody,
} from "../src";

const DUMP = [
  "/pho-code:repository-investigation",
  "",
  wrapSkillBody(
    "pho-code",
    "repository-investigation",
    "---\nname: repository-investigation\ndescription: Investigate the repo.\n---\n\n# Investigation\n\nRead the architecture docs.",
  ),
].join("\n");

describe("session titles", () => {
  test("never uses an expanded skill dump as the catalog title", () => {
    expect(deriveSessionTitle(DUMP)).toBe("Repository investigation");
    expect(sessionPromptPreview(DUMP)).toBe("/pho-code:repository-investigation");
    expect(sessionCatalogCopy(undefined, DUMP)).toEqual({
      title: "Repository investigation",
      preview: "/pho-code:repository-investigation",
    });
  });

  test("keeps the owner's extra words and humanizes leftover skill tokens", () => {
    expect(deriveSessionTitle("/pho-code:repository-investigation check the IPC bridge")).toBe(
      "Repository investigation check the IPC bridge",
    );
  });

  test("prefers a stored Pi name unless it is itself a skill dump", () => {
    expect(sessionCatalogCopy("Fix login flow", DUMP).title).toBe("Fix login flow");
    expect(sessionCatalogCopy(DUMP, "later prompt").title).toBe("Repository investigation");
  });

  test("parses a model title reply down to a short label", () => {
    expect(parseGeneratedSessionTitle('Title: "Investigate repository architecture."')).toBe(
      "Investigate repository architecture",
    );
    expect(parseGeneratedSessionTitle("```\nRepo investigation\n```")).toBe("Repo investigation");
    expect(parseGeneratedSessionTitle("...")).toBeUndefined();
  });
});
