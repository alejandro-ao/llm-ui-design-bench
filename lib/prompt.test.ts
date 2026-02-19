import { describe, expect, it } from "vitest";

import {
  buildPromptWithSkill,
  SHARED_PROMPT,
} from "@/lib/prompt";

describe("buildPromptWithSkill", () => {
  it("returns the shared prompt when skill is empty", () => {
    expect(buildPromptWithSkill(SHARED_PROMPT)).toBe(SHARED_PROMPT);
    expect(buildPromptWithSkill(SHARED_PROMPT, "   ")).toBe(SHARED_PROMPT);
  });

  it("appends a delimited user skill block when provided", () => {
    const prompt = buildPromptWithSkill(SHARED_PROMPT, "Use strong editorial typography.");

    expect(prompt).toContain(SHARED_PROMPT);
    expect(prompt).toContain("Additional user-provided design skill");
    expect(prompt).toContain("--- BEGIN USER SKILL ---");
    expect(prompt).toContain("Use strong editorial typography.");
    expect(prompt).toContain("--- END USER SKILL ---");
  });

  it("trims skill content before appending", () => {
    const prompt = buildPromptWithSkill(SHARED_PROMPT, "  Keep strong visual hierarchy.  ");
    expect(prompt).toContain("Keep strong visual hierarchy.");
    expect(prompt).not.toContain("  Keep strong visual hierarchy.  ");
  });
});
