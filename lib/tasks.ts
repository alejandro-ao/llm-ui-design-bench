import { SHARED_PROMPT } from "@/lib/prompt";

export type TaskId =
  | "html_redesign"
  | "multistep_form"
  | "image_to_code";

export interface TaskDefinition {
  id: TaskId;
  label: string;
  description: string;
  promptVersion: string;
  usesBaselineArtifact: boolean;
}

export interface TaskOption {
  id: TaskId;
  label: string;
  description: string;
}

export interface ImageToCodeReference {
  id: "figma_landing";
  label: string;
  description: string;
  assetPath: string;
  supportingAssets: {
    label: string;
    description: string;
    assetPath: string;
  }[];
}

export interface MultistepFormTaskContext {
  formVariant: "saas_onboarding";
}

export interface ImageToCodeTaskContext {
  imageId: ImageToCodeReference["id"];
  imageUrl: string;
}

export interface TaskContextById {
  html_redesign: Record<string, never>;
  multistep_form: MultistepFormTaskContext;
  image_to_code: ImageToCodeTaskContext;
}

export type TaskContext = TaskContextById[TaskId];

export class TaskValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TaskValidationError";
    this.status = status;
  }
}

export const DEFAULT_TASK_ID: TaskId = "html_redesign";

export const IMAGE_TO_CODE_REFERENCES: ImageToCodeReference[] = [
  {
    id: "figma_landing",
    label: "Figma Landing Page - Neon",
    description:
      "Dark neon marketing landing page with a glowing hero, KPI section, platform cards, and testimonial block.",
    assetPath: "/task-assets/image-to-code/figma.png",
    supportingAssets: [
      {
        label: "Hero Glow Background",
        description: "Use this image inside the hero section background glow.",
        assetPath: "/task-assets/image-to-code/hero.png",
      },
      {
        label: "Testimonial Portrait",
        description: "Use this silhouette portrait in the testimonial card.",
        assetPath: "/task-assets/image-to-code/person-silhouette.png",
      },
    ],
  },
];

const TASK_DEFINITIONS: TaskDefinition[] = [
  {
    id: "html_redesign",
    label: "HTML to HTML Redesign",
    description: "Improve an existing landing page while preserving section content and structure.",
    promptVersion: "v1",
    usesBaselineArtifact: true,
  },
  {
    id: "multistep_form",
    label: "Multi-step Form",
    description: "Build a complete SaaS onboarding wizard with validation and progress.",
    promptVersion: "v1",
    usesBaselineArtifact: false,
  },
  {
    id: "image_to_code",
    label: "Image to Code",
    description: "Implement an HTML/CSS/JS page that faithfully matches a provided mockup image.",
    promptVersion: "v1",
    usesBaselineArtifact: false,
  },
];

const TASK_DEFINITION_LOOKUP = new Map<TaskId, TaskDefinition>(
  TASK_DEFINITIONS.map((task) => [task.id, task]),
);

const IMAGE_REFERENCE_LOOKUP = new Map<ImageToCodeReference["id"], ImageToCodeReference>(
  IMAGE_TO_CODE_REFERENCES.map((reference) => [reference.id, reference]),
);

function normalizeStringField(
  value: unknown,
  fieldName: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new TaskValidationError(`Invalid ${fieldName}.`, 400);
  }

  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw new TaskValidationError(`Invalid ${fieldName}.`, 400);
  }

  return trimmed;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertTaskId(value: unknown): TaskId {
  if (typeof value !== "string") {
    throw new TaskValidationError("taskId must be a string.", 400);
  }

  if (!TASK_DEFINITION_LOOKUP.has(value as TaskId)) {
    throw new TaskValidationError("taskId is invalid.", 400);
  }

  return value as TaskId;
}

function validateImageUrl(imageUrl: string): string {
  if (!imageUrl) {
    throw new TaskValidationError("taskContext.imageUrl is required.", 400);
  }

  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TaskValidationError("taskContext.imageUrl must be an absolute http(s) URL.", 400);
    }

    return parsed.toString();
  } catch {
    throw new TaskValidationError("taskContext.imageUrl must be an absolute http(s) URL.", 400);
  }
}

function assertObjectContext(
  taskContext: unknown,
  taskId: TaskId,
): Record<string, unknown> {
  if (!isObjectRecord(taskContext)) {
    throw new TaskValidationError(`taskContext must be an object for taskId "${taskId}".`, 400);
  }

  return taskContext;
}

export function listTaskOptions(): TaskOption[] {
  return TASK_DEFINITIONS.map((task) => ({
    id: task.id,
    label: task.label,
    description: task.description,
  }));
}

export function getTaskDefinition(taskId: TaskId): TaskDefinition {
  const definition = TASK_DEFINITION_LOOKUP.get(taskId);
  if (!definition) {
    throw new TaskValidationError("taskId is invalid.", 400);
  }

  return definition;
}

export function getImageToCodeReference(
  imageId: ImageToCodeReference["id"],
): ImageToCodeReference {
  const reference = IMAGE_REFERENCE_LOOKUP.get(imageId);
  if (!reference) {
    throw new TaskValidationError("taskContext.imageId is invalid.", 400);
  }

  return reference;
}

export function resolveAssetUrl(origin: string, assetPath: string): string {
  return new URL(assetPath, origin).toString();
}

export function getDefaultTaskContext(taskId: TaskId): TaskContext {
  if (taskId === "html_redesign") {
    return {};
  }

  if (taskId === "multistep_form") {
    return {
      formVariant: "saas_onboarding",
    };
  }

  if (taskId === "image_to_code") {
    const reference = IMAGE_TO_CODE_REFERENCES[0];
    return {
      imageId: reference.id,
      imageUrl: reference.assetPath,
    };
  }

  const reference = IMAGE_TO_CODE_REFERENCES[0];
  return {
    imageId: reference.id,
    imageUrl: reference.assetPath,
  };
}

export function resolveTaskRequest(
  rawTaskId: unknown,
  rawTaskContext: unknown,
): { taskId: TaskId; taskContext: TaskContext } {
  const taskId = rawTaskId == null ? DEFAULT_TASK_ID : assertTaskId(rawTaskId);
  const fallback = getDefaultTaskContext(taskId);

  if (taskId === "html_redesign") {
    return {
      taskId,
      taskContext: {},
    };
  }

  if (taskId === "multistep_form") {
    if (rawTaskContext == null) {
      return {
        taskId,
        taskContext: fallback,
      };
    }

    const context = assertObjectContext(rawTaskContext, taskId);
    const variant = normalizeStringField(context.formVariant, "taskContext.formVariant");
    if (variant !== "saas_onboarding") {
      throw new TaskValidationError("taskContext.formVariant is invalid.", 400);
    }

    return {
      taskId,
      taskContext: {
        formVariant: "saas_onboarding",
      },
    };
  }

  if (taskId === "image_to_code") {
    if (rawTaskContext == null) {
      throw new TaskValidationError(
        "taskContext is required for taskId \"image_to_code\".",
        400,
      );
    }

    const context = assertObjectContext(rawTaskContext, taskId);
    const imageId = normalizeStringField(context.imageId, "taskContext.imageId");
    const image = getImageToCodeReference(imageId as ImageToCodeReference["id"]);
    const imageUrl = validateImageUrl(
      normalizeStringField(context.imageUrl, "taskContext.imageUrl"),
    );

    return {
      taskId,
      taskContext: {
        imageId: image.id,
        imageUrl,
      },
    };
  }

  return {
    taskId,
    taskContext: fallback as TaskContextById["image_to_code"],
  };
}

function buildMultistepFormPrompt(context: MultistepFormTaskContext): string {
  if (context.formVariant !== "saas_onboarding") {
    throw new TaskValidationError("taskContext.formVariant is invalid.", 400);
  }

  return [
    "Build a complete, production-quality multi-step SaaS onboarding form as a single HTML document.",
    "",
    "Requirements:",
    "- Use 5 steps with clear progress indicator: Account, Company, Team Invite, Plan & Billing, Review & Submit.",
    "- Each step must include realistic field labels, helper copy, and inline validation states.",
    "- Include Back/Next controls, disabled states, and final confirmation screen.",
    "- Keep all data mocked client-side only (no backend, no database).",
    "- Make it responsive and accessible (labels, focus states, keyboard-friendly interactions).",
    "- Use modern, polished visual design; the exact design direction is up to you.",
    "",
    "Output constraints:",
    "- Return one complete HTML file with embedded CSS and JS.",
    "- No markdown fences, no explanations.",
  ].join("\n");
}

function buildImageToCodePrompt(context: ImageToCodeTaskContext): string {
  const reference = getImageToCodeReference(context.imageId);
  const supportingAssetLines = reference.supportingAssets
    .map((asset) => {
      const resolvedUrl = resolveAssetUrl(context.imageUrl, asset.assetPath);
      return `- ${asset.label}: ${resolvedUrl} (${asset.description})`;
    })
    .join("\n");

  return [
    "Recreate the provided mockup image as faithfully as possible in HTML/CSS/JS.",
    "",
    `Reference image label: ${reference.label}`,
    `Reference image URL: ${context.imageUrl}`,
    `Reference intent: ${reference.description}`,
    "",
    "Supporting image assets (use these exact files where they appear in the design):",
    supportingAssetLines,
    "",
    "Requirements:",
    "- Match layout, spacing, visual hierarchy, and component structure as closely as possible.",
    "- Implement responsive behavior for mobile and desktop.",
    "- Use semantic HTML and production-quality CSS.",
    "- Keep all interactions mocked locally; no backend calls.",
    "",
    "Output constraints:",
    "- Return one complete HTML file with embedded CSS and JS.",
    "- No markdown fences, no explanations.",
  ].join("\n");
}

export function buildTaskPrompt(taskId: TaskId, taskContext: TaskContext): string {
  if (taskId === "html_redesign") {
    return SHARED_PROMPT;
  }

  if (taskId === "multistep_form") {
    return buildMultistepFormPrompt(taskContext as TaskContextById["multistep_form"]);
  }

  if (taskId === "image_to_code") {
    return buildImageToCodePrompt(taskContext as TaskContextById["image_to_code"]);
  }

  return buildImageToCodePrompt(taskContext as TaskContextById["image_to_code"]);
}
