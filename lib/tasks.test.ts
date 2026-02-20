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
        imageId: "dashboard_a",
        imageUrl: "/task-assets/image-to-code/dashboard-a.svg",
      }),
    ).toThrow("taskContext.imageUrl must be an absolute http(s) URL.");
  });

  it("accepts valid clone_website context", () => {
    const resolved = resolveTaskRequest("clone_website", {
      targetId: "airbnb_home",
      screenshotUrl: "https://example.com/clone/airbnb-home.png",
      referenceNotes: "Match layout and spacing rhythm.",
    });

    expect(resolved.taskId).toBe("clone_website");
    expect(resolved.taskContext).toMatchObject({
      targetId: "airbnb_home",
    });
  });
});

describe("buildTaskPrompt", () => {
  it("returns shared html-redesign prompt", () => {
    const prompt = buildTaskPrompt("html_redesign", getDefaultTaskContext("html_redesign"));
    expect(prompt.toLowerCase()).toContain("improve the design of this landing page");
  });

  it("builds image_to_code prompt with reference url", () => {
    const prompt = buildTaskPrompt("image_to_code", {
      imageId: "dashboard_a",
      imageUrl: "https://example.com/mockup.png",
    });

    expect(prompt).toContain("Reference image URL: https://example.com/mockup.png");
    expect(prompt).toContain("Recreate the provided mockup image");
  });

  it("builds clone_website prompt with target notes", () => {
    const prompt = buildTaskPrompt("clone_website", {
      targetId: "stripe_home",
      screenshotUrl: "https://example.com/stripe.png",
      referenceNotes: "Use strong gradient atmosphere.",
    });

    expect(prompt).toContain("Target website: Stripe Home");
    expect(prompt).toContain("Reference notes: Use strong gradient atmosphere.");
  });
});
