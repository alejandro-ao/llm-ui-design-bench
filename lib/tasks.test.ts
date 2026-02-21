import { describe, expect, it } from "vitest";

import {
  buildTaskPrompt,
  getDefaultTaskContext,
  resolveTaskRequest,
} from "@/lib/tasks";

describe("resolveTaskRequest", () => {
  it("defaults to html_redesign when taskId is missing", () => {
    const resolved = resolveTaskRequest(undefined, undefined);

    expect(resolved.taskId).toBe("html_redesign");
    expect(resolved.taskContext).toEqual({});
  });

  it("rejects unknown task ids", () => {
    expect(() => resolveTaskRequest("unknown_task", {})).toThrow("taskId is invalid.");
  });

  it("accepts valid multistep context", () => {
    const resolved = resolveTaskRequest("multistep_form", {
      formVariant: "saas_onboarding",
    });

    expect(resolved.taskId).toBe("multistep_form");
    expect(resolved.taskContext).toEqual({
      formVariant: "saas_onboarding",
    });
  });

  it("requires absolute urls for image_to_code context", () => {
    expect(() =>
      resolveTaskRequest("image_to_code", {
        imageId: "figma_landing",
        imageUrl: "/task-assets/image-to-code/figma.png",
      }),
    ).toThrow("taskContext.imageUrl must be an absolute http(s) URL.");
  });

});

describe("buildTaskPrompt", () => {
  it("returns shared html-redesign prompt", () => {
    const prompt = buildTaskPrompt("html_redesign", getDefaultTaskContext("html_redesign"));
    expect(prompt.toLowerCase()).toContain("improve the design of this landing page");
  });

  it("builds image_to_code prompt with reference url", () => {
    const prompt = buildTaskPrompt("image_to_code", {
      imageId: "figma_landing",
      imageUrl: "https://example.com/mockup.png",
    });

    expect(prompt).toContain("Reference image URL: https://example.com/mockup.png");
    expect(prompt).toContain("Hero Glow Background: https://example.com/task-assets/image-to-code/hero.png");
    expect(prompt).toContain(
      "Testimonial Portrait: https://example.com/task-assets/image-to-code/person-silhouette.png",
    );
    expect(prompt).toContain(
      "Goal: evaluate how accurately you can generate code for the provided Figma design shown on screen.",
    );
    expect(prompt).toContain(
      "Use the provided design images where they appear in the design: hero background image and testimonial silhouette portrait.",
    );
  });

});
