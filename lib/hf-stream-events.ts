import type { GenerationAttempt } from "@/lib/generation-types";

export type HfGenerationStreamEventName =
  | "meta"
  | "attempt"
  | "token"
  | "log"
  | "complete"
  | "error"
  | "done";

export interface HfGenerationStreamMetaPayload {
  taskId?: string;
  modelId: string;
  provider: string | null;
  plannedAttempts: number;
}

export interface HfGenerationStreamAttemptPayload {
  attemptNumber: number;
  totalAttempts: number;
  model: string;
  provider: string;
  resetCode: boolean;
}

export interface HfGenerationStreamTokenPayload {
  text: string;
}

export interface HfGenerationStreamLogPayload {
  message: string;
}

export interface HfGenerationStreamResultPayload {
  modelId: string;
  label: string;
  provider: string;
  vendor: string;
  html: string;
}

export interface HfGenerationStreamCompletePayload {
  result: HfGenerationStreamResultPayload;
  generation: {
    usedModel: string;
    usedProvider: string;
    attempts: GenerationAttempt[];
  };
}

export interface HfGenerationStreamErrorPayload {
  message: string;
  attempts: GenerationAttempt[];
}
