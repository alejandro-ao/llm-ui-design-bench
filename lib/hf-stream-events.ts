import type { HfGenerationAttempt } from "@/lib/hf-generation";

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
  provider: "huggingface";
  vendor: string;
  html: string;
}

export interface HfGenerationStreamCompletePayload {
  result: HfGenerationStreamResultPayload;
  generation: {
    usedModel: string;
    usedProvider: string;
    attempts: HfGenerationAttempt[];
  };
}

export interface HfGenerationStreamErrorPayload {
  message: string;
  attempts: HfGenerationAttempt[];
}
