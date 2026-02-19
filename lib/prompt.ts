export const PROMPT_VERSION = "v1";

export const SHARED_PROMPT = `Improve the design of this landing page while preserving all original content and section structure. Make it responsive, visually polished, and production-ready. Use strong typography, spacing, hierarchy, and modern layout patterns. Do not remove sections or alter product claims. Return a complete single HTML file including CSS and JS where needed.`;

export const MAX_SKILL_CONTENT_CHARS = 8000;

export function buildPromptWithSkill(sharedPrompt: string, skillContent?: string): string {
  const normalizedSkill = skillContent?.trim();
  if (!normalizedSkill) {
    return sharedPrompt;
  }

  return [
    sharedPrompt,
    "",
    "Additional user-provided design skill (apply while preserving baseline constraints):",
    "--- BEGIN USER SKILL ---",
    normalizedSkill,
    "--- END USER SKILL ---",
  ].join("\n");
}
