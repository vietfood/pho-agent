import { findCompletedSkillTokens, stripExpandedSkillBodies } from "./skills";

export const MAX_SESSION_TITLE_CHARS = 72;
export const MAX_SESSION_PREVIEW_CHARS = 160;
export const MAX_SESSION_TITLE_SEED_CHARS = 500;
export const DEFAULT_SESSION_TITLE = "New session";

const SKILL_BODY_NAME = /<<<pho-skill\b[^>]*\bname="([^"]+)"/gu;
const TITLE_LABEL_PREFIX = /^(?:session\s+)?title\s*[:：-]\s*/iu;
const TRAILING_TITLE_PUNCT = /[。.!]+$/u;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201c", "\u201d"],
  ["\u300c", "\u300d"],
  ["\u300e", "\u300f"],
];

export function compactSessionText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(compact);
  if (chars.length <= maxChars) {
    return compact;
  }
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}

export function humanizeSkillName(skillName: string): string {
  const words = skillName.split("-").filter(Boolean);
  if (words.length === 0) {
    return skillName;
  }
  return words
    .map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(" ");
}

export function looksLikeSkillDump(value: string): boolean {
  return value.includes("<<<pho-skill") || value.includes("<<<end-pho-skill>>>");
}

export function sessionPromptPreview(raw: string): string | undefined {
  const text = compactSessionText(stripExpandedSkillBodies(raw), MAX_SESSION_PREVIEW_CHARS);
  return text.length > 0 ? text : undefined;
}

export function deriveSessionTitle(raw: string): string | undefined {
  const bodyNames = skillNamesFromExpandedBodies(raw);
  let text = stripExpandedSkillBodies(raw);
  const tokens = findCompletedSkillTokens(text);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    text = `${text.slice(0, token.start)}${humanizeSkillName(token.skillName)}${text.slice(token.end)}`;
  }
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length > 0) {
    return compactSessionText(text, MAX_SESSION_TITLE_CHARS);
  }
  if (bodyNames.length === 0) {
    return undefined;
  }
  return compactSessionText(bodyNames.map(humanizeSkillName).join(", "), MAX_SESSION_TITLE_CHARS);
}

export function sessionTitleSeed(raw: string): string | undefined {
  return sessionPromptPreview(raw) ?? deriveSessionTitle(raw);
}

export function sessionCatalogCopy(
  name: string | undefined,
  firstUserText: string | undefined,
): { title: string; preview?: string } {
  const previewSource = looksLikeSkillDump(name ?? "") ? firstUserText : (firstUserText ?? name);
  const preview = previewSource ? sessionPromptPreview(previewSource) : undefined;
  return {
    title: sessionCatalogTitle(name, firstUserText),
    ...(preview ? { preview } : {}),
  };
}

export function sessionCatalogTitle(name: string | undefined, firstUserText: string | undefined): string {
  const named = name?.trim();
  if (named && !looksLikeSkillDump(named)) {
    return compactSessionText(named, MAX_SESSION_TITLE_CHARS);
  }
  return deriveSessionTitle(named ?? "") || deriveSessionTitle(firstUserText ?? "") || DEFAULT_SESSION_TITLE;
}

export function parseGeneratedSessionTitle(raw: string): string | undefined {
  let value = raw.trim();
  if (!value) {
    return undefined;
  }
  const fenced = /^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/u.exec(value);
  if (fenced) {
    value = (fenced[1] ?? "").trim();
  }
  value = value.split(/\r?\n/u, 1)[0] ?? "";
  value = value.replace(TITLE_LABEL_PREFIX, "");
  value = stripMatchingQuotes(value).replace(/\s+/gu, " ").trim();
  value = value.replace(TRAILING_TITLE_PUNCT, "").trim();
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return undefined;
  }
  return compactSessionText(value, MAX_SESSION_TITLE_CHARS);
}

function skillNamesFromExpandedBodies(raw: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(SKILL_BODY_NAME)) {
    const name = match[1];
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function stripMatchingQuotes(value: string): string {
  for (const [start, end] of QUOTE_PAIRS) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}
