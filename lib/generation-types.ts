export interface GenerationAttempt {
  model: string;
  provider: string;
  status: "success" | "error";
  statusCode?: number;
  retryable: boolean;
  durationMs: number;
  detail?: string;
}

export interface GenerationResult {
  html: string;
  usedModel: string;
  usedProvider: string;
  attempts: GenerationAttempt[];
}

export interface StreamAttemptInfo {
  attemptNumber: number;
  totalAttempts: number;
  model: string;
  provider: string;
  resetCode: boolean;
}

export interface StreamingCallbacks {
  onAttempt?: (attempt: StreamAttemptInfo) => void | Promise<void>;
  onToken?: (token: string) => void | Promise<void>;
  onLog?: (message: string) => void | Promise<void>;
}

export class GenerationError extends Error {
  status: number;
  attempts: GenerationAttempt[];

  constructor(message: string, status = 500, attempts: GenerationAttempt[] = []) {
    super(message);
    this.name = "GenerationError";
    this.status = status;
    this.attempts = attempts;
  }
}

export const SYSTEM_PROMPT =
  "You are an expert frontend engineer. Return only one complete HTML document with embedded CSS and JS. No markdown fences, no explanations.";

export function buildUserPrompt(prompt: string, baselineHtml: string): string {
  return [
    prompt,
    "",
    "Use this baseline HTML as input context:",
    "```html",
    baselineHtml,
    "```",
  ].join("\n");
}
