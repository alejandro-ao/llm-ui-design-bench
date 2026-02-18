"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { oauthLoginUrl } from "@huggingface/hub";

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
import { Separator } from "@/components/ui/separator";
import type {
  HfGenerationStreamAttemptPayload,
  HfGenerationStreamCompletePayload,
  HfGenerationStreamErrorPayload,
  HfGenerationStreamLogPayload,
  HfGenerationStreamMetaPayload,
  HfGenerationStreamTokenPayload,
} from "@/lib/hf-stream-events";

interface ArtifactSummary {
  modelId: string;
  label: string;
  provider: string;
  vendor: string;
  sourceType: "model" | "agent" | "baseline";
  artifactPath: string;
  promptVersion: string;
  createdAt: string;
  sourceRef?: string;
}

interface ArtifactsListResponse {
  entries: ArtifactSummary[];
}

interface ArtifactDetailResponse {
  entry: ArtifactSummary;
  html: string;
}

interface OAuthConfigResponse {
  enabled: boolean;
  mode: "space" | "custom";
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

interface EvaluatorClientProps {
  prompt: string;
  promptVersion: string;
}

type MainPanelTab = "code" | "app";

function pickDefaultModelId(entries: ArtifactSummary[]): string {
  const firstModel = entries.find((entry) => entry.sourceType === "model");
  if (firstModel) {
    return firstModel.modelId;
  }

  return entries[0]?.modelId ?? "";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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

function parseModelInput(input: string): { modelId: string; providerFromModel: string | null } {
  const trimmed = input.trim();
  const suffixIndex = trimmed.lastIndexOf(":");

  if (suffixIndex > 0 && suffixIndex < trimmed.length - 1) {
    const modelId = trimmed.slice(0, suffixIndex).trim();
    const provider = trimmed.slice(suffixIndex + 1).trim();

    if (modelId && provider) {
      return { modelId, providerFromModel: provider.toLowerCase() };
    }
  }

  return { modelId: trimmed, providerFromModel: null };
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

export function EvaluatorClient({ prompt, promptVersion }: EvaluatorClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [entries, setEntries] = useState<ArtifactSummary[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [hfApiKey, setHfApiKey] = useState("");
  const [generationModelId, setGenerationModelId] = useState("");
  const [generationProvider, setGenerationProvider] = useState("");
  const [generationBillTo, setGenerationBillTo] = useState("");
  const [generationLoading, setGenerationLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSuccess, setGenerationSuccess] = useState<string | null>(null);
  const [oauthConfig, setOauthConfig] = useState<OAuthConfigResponse | null>(null);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [oauthExpiresAt, setOauthExpiresAt] = useState<number | null>(null);
  const [oauthStatusLoading, setOauthStatusLoading] = useState(true);
  const [oauthActionLoading, setOauthActionLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [streamedHtml, setStreamedHtml] = useState("");
  const [activeCodeFile, setActiveCodeFile] = useState<CodeFileName>("index.html");
  const [activeMainTab, setActiveMainTab] = useState<MainPanelTab>("app");

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.modelId === selectedModelId) ?? null,
    [entries, selectedModelId],
  );

  const filteredEntries = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return entries;
    }

    return entries.filter((entry) => {
      const fields = [
        entry.label,
        entry.modelId,
        entry.vendor,
        entry.provider,
        entry.sourceRef ?? "",
      ];
      return fields.some((value) => value.toLowerCase().includes(query));
    });
  }, [entries, modelSearch]);

  const updateModelQuery = useCallback(
    (nextModelId: string) => {
      const params = new URLSearchParams(
        typeof window === "undefined" ? "" : window.location.search,
      );
      params.set("model", nextModelId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  const appendGenerationLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    setGenerationLogs((prev) => [...prev.slice(-14), `${timestamp} ${message}`]);
  }, []);

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
    } catch {
      setOauthConfig(null);
      setOauthConnected(false);
      setOauthExpiresAt(null);
    } finally {
      setOauthStatusLoading(false);
    }
  }, []);

  const loadEntries = useCallback(
    async (preferredModelId?: string) => {
      setListLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch("/api/artifacts", { cache: "no-store" });
        const payload = (await response.json()) as ArtifactsListResponse;

        if (!response.ok) {
          throw new Error("Unable to load artifact list.");
        }

        setEntries(payload.entries);

        const modelFromQuery =
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("model");
        const fallbackModelId = pickDefaultModelId(payload.entries);

        setSelectedModelId((currentSelection) => {
          const candidates = [preferredModelId, currentSelection, modelFromQuery, fallbackModelId];
          const next =
            candidates.find(
              (candidate) =>
                typeof candidate === "string" &&
                payload.entries.some((entry) => entry.modelId === candidate),
            ) ?? "";

          return next;
        });
      } catch {
        setErrorMessage("Unable to load artifacts right now.");
        setEntries([]);
        setSelectedModelId("");
      } finally {
        setListLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    void loadOAuthState();
  }, [loadOAuthState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    if (!oauthStatus) {
      return;
    }

    if (oauthStatus === "connected") {
      setGenerationSuccess("Connected with Hugging Face OAuth.");
      setGenerationError(null);
      void loadOAuthState();
    } else if (oauthStatus === "disconnected") {
      setGenerationSuccess("Disconnected from Hugging Face OAuth.");
      setGenerationError(null);
      void loadOAuthState();
    } else {
      setGenerationError("Unable to complete Hugging Face OAuth flow. Try connecting again.");
    }

    params.delete("oauth");
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [loadOAuthState, pathname, router]);

  useEffect(() => {
    if (!selectedModelId) {
      setHtml(null);
      return;
    }

    let active = true;

    const loadArtifact = async () => {
      setPreviewLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch(
          `/api/artifacts?modelId=${encodeURIComponent(selectedModelId)}`,
          {
            cache: "no-store",
          },
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("Artifact not available for this model yet.");
          }

          throw new Error("Unable to load artifact preview.");
        }

        const payload = (await response.json()) as ArtifactDetailResponse;

        if (!active) {
          return;
        }

        setHtml(payload.html);
      } catch (error) {
        if (active) {
          setHtml(null);
          setErrorMessage(
            error instanceof Error && error.message === "Artifact not available for this model yet."
              ? error.message
              : "Unable to load this artifact preview.",
          );
        }
      } finally {
        if (active) {
          setPreviewLoading(false);
        }
      }
    };

    void loadArtifact();

    return () => {
      active = false;
    };
  }, [selectedModelId]);

  const handleModelChange = useCallback(
    (nextModelId: string) => {
      setSelectedModelId(nextModelId);
      updateModelQuery(nextModelId);
    },
    [updateModelQuery],
  );

  const handleOAuthConnect = useCallback(async () => {
    if (!oauthConfig?.enabled || !oauthConfig.clientId) {
      setGenerationError("Hugging Face OAuth is not configured on this deployment.");
      return;
    }

    setGenerationError(null);
    setOauthActionLoading(true);

    try {
      const loginUrl = await oauthLoginUrl({
        clientId: oauthConfig.clientId,
        hubUrl: oauthConfig.providerUrl,
        scopes: oauthConfig.scopes.join(" "),
        redirectUrl: oauthConfig.redirectUrl,
      });

      setOauthActionLoading(false);
      window.location.assign(loginUrl);
      return;
    } catch {
      setGenerationError("Unable to start Hugging Face OAuth. Try again.");
    }

    setOauthActionLoading(false);
  }, [oauthConfig]);

  const handleOAuthDisconnect = useCallback(async () => {
    setOauthActionLoading(true);
    setGenerationError(null);

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
      setGenerationError("Unable to disconnect Hugging Face OAuth.");
    } finally {
      setOauthActionLoading(false);
    }
  }, [loadOAuthState]);

  const handleGenerate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setGenerationError(null);
      setGenerationSuccess(null);
      setGenerationLogs([]);
      setStreamedHtml("");
      setActiveCodeFile("index.html");
      setActiveMainTab("code");

      const parsedModel = parseModelInput(generationModelId);
      const modelId = parsedModel.modelId;
      const apiKey = hfApiKey.trim();
      const providerInput = parsedModel.providerFromModel ?? generationProvider.trim();
      const provider = providerInput ? providerInput.toLowerCase() : "";
      const billTo = generationBillTo.trim();

      if (!apiKey && !oauthConnected) {
        setGenerationError(
          "Add your Hugging Face API key or connect with Hugging Face OAuth to run generation.",
        );
        return;
      }

      if (!modelId) {
        setGenerationError("Add a model ID to generate an artifact.");
        return;
      }

      setIsGenerateModalOpen(false);
      setGenerationLoading(true);
      setGenerationStatus("Opening stream...");
      appendGenerationLog(`Started generation for ${modelId}.`);
      appendGenerationLog("Opening streaming connection to Hugging Face inference providers.");

      try {
        const body: {
          hfApiKey?: string;
          modelId: string;
          provider?: string;
          billTo?: string;
        } = {
          modelId,
        };
        if (apiKey) {
          body.hfApiKey = apiKey;
        }
        if (provider) {
          body.provider = provider;
        }
        if (billTo) {
          body.billTo = billTo;
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
            ? ((await response.json()) as { error?: string; attempts?: GenerationAttempt[] })
            : null;

          if (payload?.attempts?.length) {
            payload.attempts.forEach((attempt, index) => {
              appendGenerationLog(
                formatAttemptLogLine(attempt, index, payload.attempts?.length ?? 0),
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
              const metaPayload = parsedBlock.payload as HfGenerationStreamMetaPayload;
              appendGenerationLog(`Stream ready with ${metaPayload.plannedAttempts} planned attempts.`);
              setGenerationStatus("Streaming code...");
              continue;
            }

            if (parsedBlock.event === "attempt") {
              const attemptPayload = parsedBlock.payload as HfGenerationStreamAttemptPayload;
              if (attemptPayload.resetCode) {
                setStreamedHtml("");
              }
              appendGenerationLog(
                `Attempt ${attemptPayload.attemptNumber}/${attemptPayload.totalAttempts} started (${attemptPayload.model}).`,
              );
              setGenerationStatus(`Streaming ${attemptPayload.model}...`);
              continue;
            }

            if (parsedBlock.event === "token") {
              const tokenPayload = parsedBlock.payload as HfGenerationStreamTokenPayload;
              if (tokenPayload.text) {
                setStreamedHtml((previous) => previous + tokenPayload.text);
              }
              continue;
            }

            if (parsedBlock.event === "log") {
              const logPayload = parsedBlock.payload as HfGenerationStreamLogPayload;
              if (logPayload.message) {
                appendGenerationLog(logPayload.message);
              }
              continue;
            }

            if (parsedBlock.event === "complete") {
              const completePayload = parsedBlock.payload as HfGenerationStreamCompletePayload;
              completed = true;

              if (completePayload.generation.attempts?.length) {
                completePayload.generation.attempts.forEach((attempt, index) => {
                  appendGenerationLog(
                    formatAttemptLogLine(
                      attempt,
                      index,
                      completePayload.generation.attempts?.length ?? 0,
                    ),
                  );
                });
              }

              appendGenerationLog("Artifact saved. Refreshing shared model list.");
              setGenerationStatus("Refreshing shared model list...");

              const nextModelId = completePayload.entry.modelId;
              await loadEntries(nextModelId);
              setSelectedModelId(nextModelId);
              updateModelQuery(nextModelId);

              appendGenerationLog("Switching preview to newly generated model.");
              setGenerationStatus("Loading generated preview...");
              setGenerationSuccess(`Saved and published ${completePayload.entry.label}.`);
              setHfApiKey("");
              setGenerationProvider(
                provider ||
                  (completePayload.generation.usedProvider !== "auto"
                    ? completePayload.generation.usedProvider
                    : ""),
              );
              setActiveMainTab("app");
              continue;
            }

            if (parsedBlock.event === "error") {
              const errorPayload = parsedBlock.payload as HfGenerationStreamErrorPayload;
              if (errorPayload.attempts?.length) {
                errorPayload.attempts.forEach((attempt, index) => {
                  appendGenerationLog(
                    formatAttemptLogLine(attempt, index, errorPayload.attempts?.length ?? 0),
                  );
                });
              }
              throw new Error(errorPayload.message || "Generation failed.");
            }
          }
        }

        if (!completed) {
          throw new Error("Generation stream ended before completion.");
        }
      } catch (error) {
        setGenerationError((error as Error).message);
        appendGenerationLog(`Generation failed: ${(error as Error).message}`);
      } finally {
        setGenerationLoading(false);
        setGenerationStatus(null);
      }
    },
    [
      appendGenerationLog,
      generationModelId,
      generationBillTo,
      generationProvider,
      hfApiKey,
      oauthConnected,
      loadEntries,
      updateModelQuery,
    ],
  );

  const hasEntries = entries.length > 0;

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
                <CardTitle className="text-sm">Models</CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  onClick={() => {
                    setGenerationError(null);
                    setIsGenerateModalOpen(true);
                  }}
                >
                  Add Model
                </Button>
              </div>
              <CardDescription className="text-xs">
                Search and choose an artifact to preview.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-3">
              <Input
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Search models..."
                aria-label="Search models"
              />

              {generationSuccess ? (
                <p className="text-xs text-green-600 dark:text-green-400">{generationSuccess}</p>
              ) : null}
              {generationError && !isGenerateModalOpen ? (
                <p className="text-xs text-destructive">{generationError}</p>
              ) : null}

              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {listLoading ? (
                  <p className="text-sm text-muted-foreground">Loading models...</p>
                ) : !hasEntries ? (
                  <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                    <p className="text-sm text-muted-foreground">
                      No models are available yet.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setGenerationError(null);
                        setIsGenerateModalOpen(true);
                      }}
                    >
                      Add from HF
                    </Button>
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                    <p className="text-sm text-muted-foreground">
                      No model matches that search.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setGenerationError(null);
                        setIsGenerateModalOpen(true);
                      }}
                    >
                      Add from HF
                    </Button>
                  </div>
                ) : (
                  filteredEntries.map((entry) => {
                    const isActive = entry.modelId === selectedModelId;
                    return (
                      <button
                        key={entry.modelId}
                        type="button"
                        onClick={() => handleModelChange(entry.modelId)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          isActive
                            ? "border-primary bg-primary/5"
                            : "border-border bg-background hover:bg-muted/70"
                        }`}
                      >
                        <p className="truncate text-sm font-medium">{entry.label}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {entry.modelId}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 px-3 text-sm">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{selectedEntry?.provider ?? "none"}</Badge>
                <Badge variant="secondary">{selectedEntry?.vendor ?? "none"}</Badge>
                <Badge variant="outline">{selectedEntry?.sourceType ?? "none"}</Badge>
              </div>
              <Separator />
              <dl className="space-y-1 font-mono text-xs text-muted-foreground">
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">model</dt>
                  <dd className="truncate">{selectedEntry?.modelId ?? "N/A"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">prompt</dt>
                  <dd>{selectedEntry?.promptVersion ?? promptVersion}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">updated</dt>
                  <dd>{selectedEntry ? formatTimestamp(selectedEntry.createdAt) : "N/A"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">source</dt>
                  <dd className="truncate">{selectedEntry?.sourceRef ?? "N/A"}</dd>
                </div>
              </dl>
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
                  streamedHtml={streamedHtml}
                  activeFile={activeCodeFile}
                  onActiveFileChange={setActiveCodeFile}
                  generationLoading={generationLoading}
                  generationStatus={generationStatus}
                  generationLogs={generationLogs}
                  generationError={generationError}
                />
              ) : (
                <PreviewFrame
                  html={html}
                  title={selectedEntry ? `${selectedEntry.label} output` : "No selection"}
                  loading={listLoading || previewLoading}
                  errorMessage={errorMessage}
                  generationLoading={generationLoading}
                  generationStatus={generationStatus}
                />
              )}
            </div>
          </div>
        </section>
      </div>

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
                    Generate from HF
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Paste your key and provider model ID to add a new model output.
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
                      OAuth is not configured on this deployment. Use an API key fallback.
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    API Key
                    <span className="ml-1 text-muted-foreground/50">optional when OAuth is connected</span>
                  </label>
                  <Input
                    type="password"
                    value={hfApiKey}
                    onChange={(event) => setHfApiKey(event.target.value)}
                    placeholder="hf_..."
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Model ID
                  </label>
                  <Input
                    value={generationModelId}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setGenerationModelId(nextValue);

                      const parsed = parseModelInput(nextValue);
                      if (parsed.providerFromModel) {
                        setGenerationProvider(parsed.providerFromModel);
                      }
                    }}
                    placeholder="moonshotai/Kimi-K2-Instruct-0905"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Provider
                    <span className="ml-1 text-muted-foreground/50">optional</span>
                  </label>
                  <Input
                    value={generationProvider}
                    onChange={(event) => setGenerationProvider(event.target.value)}
                    placeholder="novita or fastest"
                    autoComplete="off"
                  />
                  <p className="text-[11px] leading-tight text-muted-foreground/70">
                    Tip: paste model as <code>MiniMaxAI/MiniMax-M2.5:novita</code> to auto-fill.
                  </p>
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
                    Sends <code>X-HF-Bill-To</code> with your request when provided.
                  </p>
                </div>
                <Button className="w-full" variant="accent" type="submit" disabled={generationLoading}>
                  {generationLoading ? "Generating..." : "Generate & Publish"}
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
