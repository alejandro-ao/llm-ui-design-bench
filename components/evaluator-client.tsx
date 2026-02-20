"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { CodeStreamPanel, type CodeFileName } from "@/components/code-stream-panel";
import { PreviewFrame } from "@/components/preview-frame";
import { PromptCard } from "@/components/prompt-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAX_SKILL_CONTENT_CHARS } from "@/lib/prompt";
import type {
  HfGenerationStreamAttemptPayload,
  HfGenerationStreamCompletePayload,
  HfGenerationStreamErrorPayload,
  HfGenerationStreamLogPayload,
  HfGenerationStreamMetaPayload,
  HfGenerationStreamTokenPayload,
} from "@/lib/hf-stream-events";

const BASELINE_MODEL_ID = "baseline";
const MAX_SELECTED_MODELS = 4;
const SKILL_TOO_LONG_MESSAGE = `Skill must be ${MAX_SKILL_CONTENT_CHARS} characters or fewer.`;
const OAUTH_UNAVAILABLE_MESSAGE =
  "OAuth is not configured on this deployment. For Hugging Face Spaces, add `hf_oauth: true` to README metadata and redeploy. You can still use API key fallback.";
const OAUTH_SECRET_MISCONFIGURED_MESSAGE =
  "OAuth session storage is misconfigured. Set HF_SESSION_COOKIE_SECRET (recommended) or ensure OAuth client secret env vars are available, then redeploy.";

type MainPanelTab = "code" | "app";
type SessionModelStatus = "baseline" | "queued" | "generating" | "done" | "error";

interface ArtifactBaselineResponse {
  entry: {
    modelId: string;
    label: string;
  };
  html: string;
}

interface SearchModelResult {
  modelId: string;
  label: string;
  vendor: string;
  providers: string[];
}

interface SearchModelsResponse {
  models: SearchModelResult[];
}

interface OAuthConfigResponse {
  enabled: boolean;
  mode: "space" | "custom";
  exchangeMethod: "client_secret" | "pkce";
  clientId: string | null;
  scopes: string[];
  providerUrl: string;
  redirectUrl: string;
}

interface OAuthSessionResponse {
  connected: boolean;
  expiresAt?: number | null;
}

interface GenerationAttempt {
  model: string;
  provider: string;
  status: "success" | "error";
  statusCode?: number;
  retryable: boolean;
  durationMs: number;
  detail?: string;
}

interface SessionModel {
  modelId: string;
  label: string;
  vendor: string;
  provider: string;
  sourceType: "baseline" | "model";
  providers: string[];
  status: SessionModelStatus;
  streamedHtml: string;
  finalHtml: string | null;
  logs: string[];
  attempts: GenerationAttempt[];
  error: string | null;
}

interface EvaluatorClientProps {
  prompt: string;
  promptVersion: string;
}

function formatOAuthExpiry(value: number | null): string {
  if (!value) {
    return "Session token has no explicit expiry.";
  }

  return `Token expires ${new Date(value * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function formatAttemptLogLine(
  attempt: GenerationAttempt,
  index: number,
  total: number,
): string {
  const status = attempt.status === "success" ? "ok" : "error";
  const statusCode = attempt.statusCode ? ` (${attempt.statusCode})` : "";
  const retrySuffix = attempt.retryable ? " retrying..." : "";
  return `Attempt ${index + 1}/${total}: ${attempt.model} [${attempt.provider}] ${status}${statusCode}${retrySuffix}`;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("application/json");
}

function getGenerationStatusMessage(status: number): string {
  if (status === 504 || status === 408) {
    return "Generation timed out upstream. Try a faster model/provider or retry.";
  }

  if (status === 429) {
    return "Generation was rate limited. Retry in a moment.";
  }

  if (status >= 500) {
    return "Generation failed due to an upstream provider error. Retry shortly.";
  }

  return `Generation failed with status ${status}.`;
}

function getOAuthConnectErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (normalized.includes("missing clientid")) {
    return OAUTH_UNAVAILABLE_MESSAGE;
  }

  if (normalized.includes("permission") || normalized.includes("navigation")) {
    return "Unable to start Hugging Face OAuth from this embedded view. Open the direct `*.hf.space` URL and retry.";
  }

  return "Unable to start Hugging Face OAuth. Try again.";
}

function parseSseEventBlock(
  block: string,
): { event: string; payload: unknown } | null {
  const normalizedBlock = block.replace(/\r/g, "");
  const lines = normalizedBlock.split("\n");

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawPayload = dataLines.join("\n");

  try {
    const payload = JSON.parse(rawPayload) as unknown;
    return {
      event: eventName,
      payload,
    };
  } catch {
    return null;
  }
}

function buildInitialBaselineModel(): SessionModel {
  return {
    modelId: BASELINE_MODEL_ID,
    label: "Baseline (Original)",
    vendor: "baseline",
    provider: "reference",
    sourceType: "baseline",
    providers: [],
    status: "baseline",
    streamedHtml: "",
    finalHtml: null,
    logs: [],
    attempts: [],
    error: null,
  };
}

function getStatusBadge(status: SessionModelStatus) {
  if (status === "generating") {
    return <Badge variant="default">generating</Badge>;
  }

  if (status === "done") {
    return <Badge variant="secondary">done</Badge>;
  }

  if (status === "error") {
    return <Badge variant="destructive">error</Badge>;
  }

  if (status === "queued") {
    return <Badge variant="outline">queued</Badge>;
  }

  return <Badge variant="outline">baseline</Badge>;
}

export function EvaluatorClient({ prompt, promptVersion }: EvaluatorClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [sessionModels, setSessionModels] = useState<SessionModel[]>([buildInitialBaselineModel()]);
  const [selectedModelId, setSelectedModelId] = useState(BASELINE_MODEL_ID);
  const [baselineLoading, setBaselineLoading] = useState(true);
  const [baselineError, setBaselineError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchModelResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState("");
  const [skillDraft, setSkillDraft] = useState("");
  const [isSkillModalOpen, setIsSkillModalOpen] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);

  const [hfApiKey, setHfApiKey] = useState("");
  const [generationBillTo, setGenerationBillTo] = useState("");
  const [generationLoading, setGenerationLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSuccess, setGenerationSuccess] = useState<string | null>(null);
  const [activeGeneratingModelId, setActiveGeneratingModelId] = useState<string | null>(null);

  const [oauthConfig, setOauthConfig] = useState<OAuthConfigResponse | null>(null);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [oauthExpiresAt, setOauthExpiresAt] = useState<number | null>(null);
  const [oauthStatusLoading, setOauthStatusLoading] = useState(true);
  const [oauthActionLoading, setOauthActionLoading] = useState(false);
  const [oauthUiError, setOauthUiError] = useState<string | null>(null);

  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [activeCodeFile, setActiveCodeFile] = useState<CodeFileName>("index.html");
  const [activeMainTab, setActiveMainTab] = useState<MainPanelTab>("app");

  const selectedModels = useMemo(
    () => sessionModels.filter((model) => model.sourceType === "model"),
    [sessionModels],
  );

  const selectedModel = useMemo(
    () =>
      sessionModels.find((model) => model.modelId === selectedModelId) ??
      sessionModels[0] ??
      buildInitialBaselineModel(),
    [selectedModelId, sessionModels],
  );

  const selectedModelCode = useMemo(() => {
    return selectedModel.streamedHtml || selectedModel.finalHtml || "";
  }, [selectedModel.finalHtml, selectedModel.streamedHtml]);

  const selectedModelIsGenerating =
    generationLoading && activeGeneratingModelId === selectedModel.modelId;

  const patchSessionModel = useCallback(
    (modelId: string, updater: (model: SessionModel) => SessionModel) => {
      setSessionModels((previous) =>
        previous.map((model) => (model.modelId === modelId ? updater(model) : model)),
      );
    },
    [],
  );

  const appendModelLog = useCallback(
    (modelId: string, message: string) => {
      const timestamp = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      patchSessionModel(modelId, (model) => ({
        ...model,
        logs: [...model.logs.slice(-39), `${timestamp} ${message}`],
      }));
    },
    [patchSessionModel],
  );

  const loadOAuthState = useCallback(async () => {
    setOauthStatusLoading(true);

    try {
      const [configResponse, sessionResponse] = await Promise.all([
        fetch("/api/auth/hf/config", { cache: "no-store" }),
        fetch("/api/auth/hf/session", { cache: "no-store" }),
      ]);

      if (configResponse.ok) {
        const configPayload = (await configResponse.json()) as OAuthConfigResponse;
        setOauthConfig(configPayload);
      } else {
        setOauthConfig(null);
      }

      if (sessionResponse.ok) {
        const sessionPayload = (await sessionResponse.json()) as OAuthSessionResponse;
        setOauthConnected(Boolean(sessionPayload.connected));
        setOauthExpiresAt(sessionPayload.connected ? (sessionPayload.expiresAt ?? null) : null);
      } else {
        setOauthConnected(false);
        setOauthExpiresAt(null);
      }

      setOauthUiError(null);
    } catch {
      setOauthConfig(null);
      setOauthConnected(false);
      setOauthExpiresAt(null);
      setOauthUiError("Unable to check Hugging Face OAuth status right now.");
    } finally {
      setOauthStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOAuthState();
  }, [loadOAuthState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    const oauthStatusError = params.get("oauth_error");
    if (!oauthStatus) {
      return;
    }

    if (oauthStatus === "connected") {
      setGenerationSuccess("Connected with Hugging Face OAuth.");
      setGenerationError(null);
      setOauthUiError(null);
      void loadOAuthState();
    } else if (oauthStatus === "disconnected") {
      setGenerationSuccess("Disconnected from Hugging Face OAuth.");
      setGenerationError(null);
      setOauthUiError(null);
      void loadOAuthState();
    } else if (oauthStatus === "disabled") {
      setOauthUiError(OAUTH_UNAVAILABLE_MESSAGE);
    } else if (oauthStatus === "session_secret") {
      setOauthUiError(oauthStatusError || OAUTH_SECRET_MISCONFIGURED_MESSAGE);
    } else if (oauthStatus === "missing_pkce") {
      setOauthUiError(
        oauthStatusError ||
          "OAuth verifier state was missing. If you opened the embedded Spaces view, open the direct `*.hf.space` URL and try again.",
      );
    } else if (oauthStatus === "exchange_failed") {
      setOauthUiError(
        oauthStatusError || "Unable to complete Hugging Face OAuth exchange. Try connecting again.",
      );
    } else {
      setOauthUiError("Unable to complete Hugging Face OAuth flow. Try connecting again.");
    }

    params.delete("oauth");
    params.delete("oauth_error");
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [loadOAuthState, pathname, router]);

  useEffect(() => {
    let active = true;

    const loadBaseline = async () => {
      setBaselineLoading(true);
      setBaselineError(null);

      try {
        const response = await fetch(
          `/api/artifacts?modelId=${encodeURIComponent(BASELINE_MODEL_ID)}`,
          {
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error("Unable to load baseline artifact.");
        }

        const payload = (await response.json()) as ArtifactBaselineResponse;
        if (!active) {
          return;
        }

        patchSessionModel(BASELINE_MODEL_ID, (model) => ({
          ...model,
          label: payload.entry.label,
          finalHtml: payload.html,
          streamedHtml: payload.html,
          error: null,
        }));
      } catch {
        if (active) {
          setBaselineError("Unable to load baseline preview.");
          patchSessionModel(BASELINE_MODEL_ID, (model) => ({
            ...model,
            finalHtml: null,
            streamedHtml: "",
          }));
        }
      } finally {
        if (active) {
          setBaselineLoading(false);
        }
      }
    };

    void loadBaseline();

    return () => {
      active = false;
    };
  }, [patchSessionModel]);

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    let active = true;
    const timeoutId = setTimeout(() => {
      void (async () => {
        setSearchLoading(true);
        setSearchError(null);

        try {
          const response = await fetch(
            `/api/hf/models/search?q=${encodeURIComponent(trimmedQuery)}&limit=10`,
            {
              cache: "no-store",
            },
          );

          if (!response.ok) {
            throw new Error("Unable to search Hugging Face models.");
          }

          const payload = (await response.json()) as SearchModelsResponse;
          if (!active) {
            return;
          }

          setSearchResults(payload.models);
        } catch {
          if (active) {
            setSearchError("Unable to search models right now.");
            setSearchResults([]);
          }
        } finally {
          if (active) {
            setSearchLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  const addModelToSelection = useCallback(
    (result: SearchModelResult) => {
      if (sessionModels.some((model) => model.modelId === result.modelId)) {
        setSelectionNotice(`${result.modelId} is already selected.`);
        return;
      }

      if (selectedModels.length >= MAX_SELECTED_MODELS) {
        setSelectionNotice(`You can compare up to ${MAX_SELECTED_MODELS} models at once.`);
        return;
      }

      setSessionModels((previous) => [
        ...previous,
        {
          modelId: result.modelId,
          label: result.label,
          vendor: result.vendor,
          provider: "huggingface",
          sourceType: "model",
          providers: result.providers,
          status: "queued",
          streamedHtml: "",
          finalHtml: null,
          logs: [],
          attempts: [],
          error: null,
        },
      ]);
      setSelectionNotice(null);
      setSearchQuery("");
      setSearchResults([]);
    },
    [selectedModels.length, sessionModels],
  );

  const removeSelectedModel = useCallback(
    (modelId: string) => {
      if (generationLoading) {
        return;
      }

      setSessionModels((previous) => previous.filter((model) => model.modelId !== modelId));
      if (selectedModelId === modelId) {
        setSelectedModelId(BASELINE_MODEL_ID);
      }
      setSelectionNotice(null);
    },
    [generationLoading, selectedModelId],
  );

  const openSkillModal = useCallback(() => {
    setSkillDraft(skillContent);
    setSkillError(null);
    setIsSkillModalOpen(true);
  }, [skillContent]);

  const closeSkillModal = useCallback(() => {
    setIsSkillModalOpen(false);
    setSkillError(null);
    setSkillDraft(skillContent);
  }, [skillContent]);

  const handleSaveSkill = useCallback(() => {
    const normalizedSkill = skillDraft.trim();
    if (normalizedSkill.length > MAX_SKILL_CONTENT_CHARS) {
      setSkillError(SKILL_TOO_LONG_MESSAGE);
      return;
    }

    setSkillContent(normalizedSkill);
    setSkillError(null);
    setIsSkillModalOpen(false);
  }, [skillDraft]);

  const handleClearSkill = useCallback(() => {
    setSkillDraft("");
    setSkillContent("");
    setSkillError(null);
  }, []);

  const handleOAuthConnect = useCallback(async () => {
    if (!oauthConfig?.enabled || !oauthConfig.clientId) {
      setOauthUiError(OAUTH_UNAVAILABLE_MESSAGE);
      return;
    }

    setGenerationError(null);
    setOauthUiError(null);
    setOauthActionLoading(true);

    try {
      const loginUrl = "/api/auth/hf/start";
      setOauthActionLoading(false);
      window.location.assign(loginUrl);
      return;
    } catch (error) {
      console.error("[evaluator-client] oauth_connect_failed", error);
      setOauthUiError(getOAuthConnectErrorMessage(error));
    }

    setOauthActionLoading(false);
  }, [oauthConfig]);

  const handleOAuthDisconnect = useCallback(async () => {
    setOauthActionLoading(true);
    setGenerationError(null);
    setOauthUiError(null);

    try {
      const response = await fetch("/api/auth/hf/session", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Unable to disconnect Hugging Face OAuth.");
      }

      setGenerationSuccess("Disconnected from Hugging Face OAuth.");
      setOauthConnected(false);
      setOauthExpiresAt(null);
      await loadOAuthState();
    } catch {
      setOauthUiError("Unable to disconnect Hugging Face OAuth.");
    } finally {
      setOauthActionLoading(false);
    }
  }, [loadOAuthState]);

  const handleGenerate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setGenerationError(null);
      setGenerationSuccess(null);
      setActiveCodeFile("index.html");

      const apiKey = hfApiKey.trim();
      const billTo = generationBillTo.trim();
      const normalizedSkill = skillContent.trim();

      if (!selectedModels.length) {
        setGenerationError("Select at least one model to generate.");
        return;
      }

      if (!apiKey && !oauthConnected) {
        setGenerationError(
          "Add your Hugging Face API key or connect with Hugging Face OAuth to run generation.",
        );
        return;
      }

      if (normalizedSkill.length > MAX_SKILL_CONTENT_CHARS) {
        setGenerationError(SKILL_TOO_LONG_MESSAGE);
        return;
      }

      setSessionModels((previous) =>
        previous.map((model) =>
          model.sourceType === "model"
            ? {
                ...model,
                status: "queued",
                streamedHtml: "",
                finalHtml: null,
                logs: [],
                attempts: [],
                error: null,
              }
            : model,
        ),
      );

      setIsGenerateModalOpen(false);
      setGenerationLoading(true);

      let failedCount = 0;

      for (const [index, model] of selectedModels.entries()) {
        const queuePosition = `${index + 1}/${selectedModels.length}`;
        setGenerationStatus(`Generating ${model.label} (${queuePosition})...`);
        setActiveGeneratingModelId(model.modelId);
        setSelectedModelId(model.modelId);
        setActiveMainTab("code");

        patchSessionModel(model.modelId, (current) => ({
          ...current,
          status: "generating",
          streamedHtml: "",
          finalHtml: null,
          logs: [],
          attempts: [],
          error: null,
        }));
        appendModelLog(model.modelId, `Started generation (${queuePosition}).`);

        try {
          const body: {
            hfApiKey?: string;
            modelId: string;
            billTo?: string;
            skillContent?: string;
          } = {
            modelId: model.modelId,
          };

          if (apiKey) {
            body.hfApiKey = apiKey;
          }

          if (billTo) {
            body.billTo = billTo;
          }

          if (normalizedSkill) {
            body.skillContent = normalizedSkill;
          }

          const response = await fetch("/api/generate/hf/stream", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const payload = isJsonResponse(response)
              ? ((await response.json()) as {
                  error?: string;
                  attempts?: GenerationAttempt[];
                })
              : null;

            if (payload?.attempts?.length) {
              patchSessionModel(model.modelId, (current) => ({
                ...current,
                attempts: payload.attempts ?? [],
              }));
              payload.attempts.forEach((attempt, attemptIndex) => {
                appendModelLog(
                  model.modelId,
                  formatAttemptLogLine(
                    attempt,
                    attemptIndex,
                    payload.attempts?.length ?? 0,
                  ),
                );
              });
            }

            throw new Error(payload?.error ?? getGenerationStatusMessage(response.status));
          }

          if (!response.body) {
            throw new Error("Streaming response body is not available.");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let done = false;
          let buffer = "";
          let completed = false;

          while (!done) {
            const result = await reader.read();
            done = result.done;
            buffer += decoder.decode(result.value ?? new Uint8Array(), {
              stream: !done,
            });

            let separatorIndex = buffer.indexOf("\n\n");
            while (separatorIndex >= 0) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              separatorIndex = buffer.indexOf("\n\n");

              const parsedBlock = parseSseEventBlock(block);
              if (!parsedBlock) {
                continue;
              }

              if (parsedBlock.event === "meta") {
                const payload = parsedBlock.payload as HfGenerationStreamMetaPayload;
                appendModelLog(
                  model.modelId,
                  `Stream ready with ${payload.plannedAttempts} planned attempts.`,
                );
                continue;
              }

              if (parsedBlock.event === "attempt") {
                const payload = parsedBlock.payload as HfGenerationStreamAttemptPayload;
                if (payload.resetCode) {
                  patchSessionModel(model.modelId, (current) => ({
                    ...current,
                    streamedHtml: "",
                  }));
                }

                appendModelLog(
                  model.modelId,
                  `Attempt ${payload.attemptNumber}/${payload.totalAttempts} started (${payload.model}).`,
                );
                continue;
              }

              if (parsedBlock.event === "token") {
                const payload = parsedBlock.payload as HfGenerationStreamTokenPayload;
                if (!payload.text) {
                  continue;
                }

                patchSessionModel(model.modelId, (current) => ({
                  ...current,
                  streamedHtml: current.streamedHtml + payload.text,
                }));
                continue;
              }

              if (parsedBlock.event === "log") {
                const payload = parsedBlock.payload as HfGenerationStreamLogPayload;
                if (payload.message) {
                  appendModelLog(model.modelId, payload.message);
                }
                continue;
              }

              if (parsedBlock.event === "complete") {
                const payload = parsedBlock.payload as HfGenerationStreamCompletePayload;
                completed = true;

                patchSessionModel(model.modelId, (current) => ({
                  ...current,
                  status: "done",
                  finalHtml: payload.result.html,
                  streamedHtml: payload.result.html,
                  attempts: payload.generation.attempts,
                  error: null,
                }));

                payload.generation.attempts.forEach((attempt, attemptIndex) => {
                  appendModelLog(
                    model.modelId,
                    formatAttemptLogLine(
                      attempt,
                      attemptIndex,
                      payload.generation.attempts.length,
                    ),
                  );
                });

                appendModelLog(model.modelId, "Generation complete for this session.");
                setActiveMainTab("app");
                continue;
              }

              if (parsedBlock.event === "error") {
                const payload = parsedBlock.payload as HfGenerationStreamErrorPayload;
                patchSessionModel(model.modelId, (current) => ({
                  ...current,
                  attempts: payload.attempts ?? current.attempts,
                }));

                if (payload.attempts?.length) {
                  payload.attempts.forEach((attempt, attemptIndex) => {
                    appendModelLog(
                      model.modelId,
                      formatAttemptLogLine(
                        attempt,
                        attemptIndex,
                        payload.attempts?.length ?? 0,
                      ),
                    );
                  });
                }

                throw new Error(payload.message || "Generation failed.");
              }
            }
          }

          if (!completed) {
            throw new Error("Generation stream ended before completion.");
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Unable to generate this model in the current session.";

          failedCount += 1;
          patchSessionModel(model.modelId, (current) => ({
            ...current,
            status: "error",
            error: message,
            finalHtml: null,
          }));
          appendModelLog(model.modelId, `Generation failed: ${message}`);
          setActiveMainTab("app");
        }
      }

      setGenerationLoading(false);
      setActiveGeneratingModelId(null);
      setGenerationStatus(null);

      if (failedCount > 0) {
        setGenerationError(
          `${failedCount} of ${selectedModels.length} model generations failed. Completed outputs are available for the rest.`,
        );
      } else {
        setGenerationSuccess(
          `Generated ${selectedModels.length} model output${selectedModels.length > 1 ? "s" : ""} in this session only.`,
        );
      }

    },
    [
      appendModelLog,
      generationBillTo,
      hfApiKey,
      oauthConnected,
      patchSessionModel,
      skillContent,
      selectedModels,
    ],
  );

  const handleSearchInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }

      if (searchResults.length === 0) {
        return;
      }

      event.preventDefault();
      addModelToSelection(searchResults[0]);
    },
    [addModelToSelection, searchResults],
  );

  const previewHtml = selectedModel.finalHtml;

  const previewErrorMessage = useMemo(() => {
    if (selectedModel.sourceType === "baseline") {
      return baselineError;
    }

    if (selectedModel.error) {
      return selectedModel.error;
    }

    if (!selectedModel.finalHtml) {
      if (selectedModel.status === "generating") {
        return "Generation in progress for this model.";
      }

      return "No generated output yet for this model.";
    }

    return null;
  }, [baselineError, selectedModel]);

  const canOpenGenerateModal = selectedModels.length > 0;

  return (
    <>
      <div className="grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-border bg-sidebar p-4 lg:border-r lg:border-b-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="inline-flex items-center gap-1.5">
                <div className="size-2.5 rounded-full bg-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Frontend Evals
                </span>
              </div>
              <h1 className="mt-1.5 text-lg leading-tight font-semibold">
                Model Comparison
              </h1>
            </div>
            <ThemeToggle />
          </div>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Search Models</CardTitle>
                <Badge variant="outline">Max {MAX_SELECTED_MODELS}</Badge>
              </div>
              <CardDescription className="text-xs">
                Search Hugging Face inference-provider models and add up to {MAX_SELECTED_MODELS}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-3">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                placeholder="Search models on HF..."
                aria-label="Search Hugging Face models"
                disabled={generationLoading}
              />

              {searchLoading ? (
                <p className="text-xs text-muted-foreground">Searching models...</p>
              ) : null}

              {searchError ? <p className="text-xs text-destructive">{searchError}</p> : null}

              {!searchLoading && searchQuery.trim().length >= 2 ? (
                searchResults.length > 0 ? (
                  <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                    {searchResults.map((result) => (
                      <button
                        key={result.modelId}
                        type="button"
                        onClick={() => addModelToSelection(result)}
                        disabled={generationLoading}
                        className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <p className="truncate text-sm font-medium">{result.label}</p>
                        <p className="truncate text-xs text-muted-foreground">{result.modelId}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No matching inference-provider models found.</p>
                )
              ) : null}

              {selectionNotice ? (
                <p className="text-xs text-muted-foreground">{selectionNotice}</p>
              ) : null}

              <div className="space-y-2 rounded-lg border border-dashed border-border p-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Selected Models
                </p>
                {selectedModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No models selected yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {selectedModels.map((model) => (
                      <li key={model.modelId} className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-foreground">{model.modelId}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={generationLoading}
                          onClick={() => removeSelectedModel(model.modelId)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={generationLoading}
                  onClick={openSkillModal}
                >
                  {skillContent ? "Edit Skill" : "Add Skill"}
                </Button>
                <Button
                  type="button"
                  variant="accent"
                  disabled={!canOpenGenerateModal || generationLoading}
                  onClick={() => {
                    setGenerationError(null);
                    setIsGenerateModalOpen(true);
                  }}
                >
                  Generate Selected
                </Button>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Generated outputs are kept in memory for this browser session only.
              </p>

              {skillContent ? (
                <p className="text-[11px] text-muted-foreground">
                  Skill attached • {skillContent.length} chars
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No skill attached.
                </p>
              )}

              {generationSuccess ? (
                <p className="text-xs text-green-600 dark:text-green-400">{generationSuccess}</p>
              ) : null}
              {generationError && !isGenerateModalOpen ? (
                <p className="text-xs text-destructive">{generationError}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Hugging Face Auth</CardTitle>
                <Badge
                  variant={oauthStatusLoading ? "outline" : oauthConnected ? "default" : "outline"}
                >
                  {oauthStatusLoading ? "checking" : oauthConnected ? "connected" : "not connected"}
                </Badge>
              </div>
              <CardDescription className="text-xs">
                Connect once to generate without manually pasting a key every time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 px-3">
              {oauthStatusLoading ? (
                <p className="text-xs text-muted-foreground">Checking OAuth session...</p>
              ) : oauthConfig?.enabled ? (
                oauthConnected ? (
                  <>
                    <p className="text-xs text-muted-foreground">{formatOAuthExpiry(oauthExpiresAt)}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={handleOAuthDisconnect}
                      disabled={oauthActionLoading || generationLoading}
                    >
                      {oauthActionLoading ? "Disconnecting..." : "Disconnect Hugging Face"}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={handleOAuthConnect}
                    disabled={oauthActionLoading || generationLoading}
                  >
                    {oauthActionLoading ? "Opening OAuth..." : "Connect with Hugging Face"}
                  </Button>
                )
              ) : (
                <p className="text-xs text-muted-foreground">{OAUTH_UNAVAILABLE_MESSAGE}</p>
              )}

              {oauthUiError ? <p className="text-xs text-destructive">{oauthUiError}</p> : null}
            </CardContent>
          </Card>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <CardTitle className="text-sm">Session Models</CardTitle>
              <CardDescription className="text-xs">
                Baseline plus selected models to compare.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 px-3">
              {sessionModels.map((model) => {
                const isActive = model.modelId === selectedModelId;
                return (
                  <button
                    key={model.modelId}
                    type="button"
                    onClick={() => setSelectedModelId(model.modelId)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:bg-muted/70"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{model.label}</p>
                      {getStatusBadge(model.status)}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{model.modelId}</p>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <PromptCard prompt={prompt} promptVersion={promptVersion} />
        </aside>

        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
            <div className="border-b border-border px-4 py-2">
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setActiveMainTab("code")}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    activeMainTab === "code"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Code
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMainTab("app")}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    activeMainTab === "app"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {activeMainTab === "code" ? (
                <CodeStreamPanel
                  streamedHtml={selectedModelCode}
                  activeFile={activeCodeFile}
                  onActiveFileChange={setActiveCodeFile}
                  generationLoading={selectedModelIsGenerating}
                  generationStatus={selectedModelIsGenerating ? generationStatus : null}
                  generationLogs={selectedModel.logs}
                  generationError={selectedModel.error}
                />
              ) : (
                <PreviewFrame
                  html={previewHtml}
                  title={`${selectedModel.label} output`}
                  loading={selectedModel.modelId === BASELINE_MODEL_ID && baselineLoading}
                  errorMessage={previewErrorMessage}
                  generationLoading={selectedModelIsGenerating}
                  generationStatus={selectedModelIsGenerating ? generationStatus : null}
                />
              )}
            </div>
          </div>
        </section>
      </div>

      {isSkillModalOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-modal-title"
          onClick={closeSkillModal}
        >
          <Card
            className="w-full max-w-2xl gap-3 py-3"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="px-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle id="skill-modal-title" className="text-base">
                    Add Skill Context
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Paste custom design skill instructions. This skill applies to all models in this generation batch.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={closeSkillModal}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="skill-content"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Skill Content
                </label>
                <textarea
                  id="skill-content"
                  value={skillDraft}
                  onChange={(event) => {
                    setSkillDraft(event.target.value);
                    if (skillError) {
                      setSkillError(null);
                    }
                  }}
                  placeholder="Paste your frontend design skill content here..."
                  className="h-52 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring"
                />
                <p className="text-[11px] text-muted-foreground">
                  {skillDraft.trim().length}/{MAX_SKILL_CONTENT_CHARS} characters
                </p>
              </div>

              {skillError ? (
                <p className="text-xs text-destructive">{skillError}</p>
              ) : null}

              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="accent"
                  onClick={handleSaveSkill}
                >
                  Save Skill
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClearSkill}
                >
                  Clear Skill
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeSkillModal}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {isGenerateModalOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="generate-model-title"
          onClick={() => {
            if (!generationLoading) {
              setIsGenerateModalOpen(false);
            }
          }}
        >
          <Card
            className="w-full max-w-xl gap-3 py-3"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="px-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle id="generate-model-title" className="text-base">
                    Generate Session Outputs
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Generate all selected models in sequence. Outputs are stored only in memory for this session.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsGenerateModalOpen(false)}
                  disabled={generationLoading}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-4">
              <form className="space-y-2.5" onSubmit={handleGenerate}>
                <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground">Hugging Face OAuth</p>
                    <Badge variant={oauthConnected ? "default" : "outline"}>
                      {oauthConnected ? "connected" : "not connected"}
                    </Badge>
                  </div>

                  {oauthStatusLoading ? (
                    <p className="text-xs text-muted-foreground">Checking OAuth session...</p>
                  ) : oauthConfig?.enabled ? (
                    oauthConnected ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {formatOAuthExpiry(oauthExpiresAt)}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={handleOAuthDisconnect}
                          disabled={oauthActionLoading || generationLoading}
                        >
                          {oauthActionLoading ? "Disconnecting..." : "Disconnect Hugging Face"}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={handleOAuthConnect}
                        disabled={oauthActionLoading || generationLoading}
                      >
                        {oauthActionLoading ? "Opening OAuth..." : "Connect with Hugging Face"}
                      </Button>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {OAUTH_UNAVAILABLE_MESSAGE}
                    </p>
                  )}

                  {oauthUiError ? (
                    <p className="text-xs text-destructive">{oauthUiError}</p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    API Key
                    <span className="ml-1 text-muted-foreground/50">optional when OAuth is connected</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      value={hfApiKey}
                      onChange={(event) => setHfApiKey(event.target.value)}
                      placeholder="hf_..."
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setHfApiKey("")}
                      disabled={generationLoading || hfApiKey.length === 0}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Bill To
                    <span className="ml-1 text-muted-foreground/50">optional</span>
                  </label>
                  <Input
                    value={generationBillTo}
                    onChange={(event) => setGenerationBillTo(event.target.value)}
                    placeholder="huggingface"
                    autoComplete="off"
                  />
                  <p className="text-[11px] leading-tight text-muted-foreground/70">
                    Sends <code>X-HF-Bill-To</code> when provided.
                  </p>
                </div>

                <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  Generating {selectedModels.length} selected model
                  {selectedModels.length === 1 ? "" : "s"}.
                </div>

                <Button className="w-full" variant="accent" type="submit" disabled={generationLoading}>
                  {generationLoading ? "Generating..." : "Generate Selected Models"}
                </Button>

                {generationError ? (
                  <p className="text-xs text-destructive">{generationError}</p>
                ) : null}
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
