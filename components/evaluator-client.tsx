"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ModelSelector, type ModelOption } from "@/components/model-selector";
import { PreviewFrame } from "@/components/preview-frame";
import { PromptCard } from "@/components/prompt-card";
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

interface ArtifactSummary extends ModelOption {
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

interface GenerationAttempt {
  model: string;
  provider: string;
  status: "success" | "error";
  statusCode?: number;
  retryable: boolean;
  durationMs: number;
  detail?: string;
}

interface GenerationMetadata {
  usedModel: string;
  usedProvider: string;
  attempts: GenerationAttempt[];
}

interface GenerateHfResponse {
  ok: boolean;
  entry: ArtifactSummary;
  generation?: GenerationMetadata;
}

interface ApiErrorResponse {
  error?: string;
  attempts?: GenerationAttempt[];
}

interface EvaluatorClientProps {
  prompt: string;
  promptVersion: string;
}

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
  const [generationLoading, setGenerationLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSuccess, setGenerationSuccess] = useState<string | null>(null);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.modelId === selectedModelId) ?? null,
    [entries, selectedModelId],
  );

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

    setGenerationLogs((prev) => [...prev.slice(-5), `${timestamp} ${message}`]);
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

  const handleGenerate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setGenerationError(null);
      setGenerationSuccess(null);
      setGenerationLogs([]);

      const parsedModel = parseModelInput(generationModelId);
      const modelId = parsedModel.modelId;
      const apiKey = hfApiKey.trim();
      const providerInput = parsedModel.providerFromModel ?? generationProvider.trim();
      const provider = providerInput ? providerInput.toLowerCase() : "";

      if (!apiKey) {
        setGenerationError("Add your Hugging Face API key to run generation.");
        return;
      }

      if (!modelId) {
        setGenerationError("Add a model ID to generate an artifact.");
        return;
      }

      setGenerationLoading(true);
      setGenerationStatus("Contacting Hugging Face provider...");
      appendGenerationLog(`Started generation for ${modelId}.`);
      appendGenerationLog("Sending request to Hugging Face inference providers.");

      try {
        const body: {
          hfApiKey: string;
          modelId: string;
          provider?: string;
        } = {
          hfApiKey: apiKey,
          modelId,
        };
        if (provider) {
          body.provider = provider;
        }

        const response = await fetch("/api/generate/hf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const payload = isJsonResponse(response)
          ? ((await response.json()) as GenerateHfResponse & ApiErrorResponse)
          : null;

        if (payload?.attempts?.length) {
          payload.attempts.forEach((attempt, index) => {
            appendGenerationLog(formatAttemptLogLine(attempt, index, payload.attempts?.length ?? 0));
          });
        }

        if (!response.ok) {
          throw new Error(payload?.error ?? getGenerationStatusMessage(response.status));
        }

        if (!payload) {
          throw new Error("Generation response was not valid JSON.");
        }

        if (payload.generation?.attempts?.length) {
          payload.generation.attempts.forEach((attempt, index) => {
            appendGenerationLog(
              formatAttemptLogLine(attempt, index, payload.generation?.attempts?.length ?? 0),
            );
          });
        }

        appendGenerationLog("Model output received. Saving artifact.");
        setGenerationStatus("Persisting generated artifact...");

        const nextModelId = payload.entry.modelId;

        appendGenerationLog("Artifact saved. Refreshing shared model list.");
        setGenerationStatus("Refreshing shared model list...");
        await loadEntries(nextModelId);
        setSelectedModelId(nextModelId);
        updateModelQuery(nextModelId);

        appendGenerationLog("Switching preview to newly generated model.");
        setGenerationStatus("Loading generated preview...");
        setGenerationSuccess(`Saved and published ${payload.entry.label}.`);
        setHfApiKey("");
        setGenerationProvider(
          provider ||
            (payload.generation?.usedProvider && payload.generation.usedProvider !== "auto"
              ? payload.generation.usedProvider
              : ""),
        );
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
      generationProvider,
      hfApiKey,
      loadEntries,
      updateModelQuery,
    ],
  );

  const hasEntries = entries.length > 0;

  return (
    <div className="grid h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-xl shadow-black/10 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-border/70 bg-gradient-to-b from-white/90 to-secondary/20 p-4 lg:border-r lg:border-b-0 lg:p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Frontend Evals
          </p>
          <h1 className="mt-2 text-2xl leading-tight font-semibold">
            Model Comparison Dashboard
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Same prompt. Same baseline. Different model output.
          </p>
        </div>

        <Card className="gap-4 border-border/70 bg-white/75 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Generate from Hugging Face</CardTitle>
            <CardDescription>
              Paste your key and any HF provider model ID.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <form className="space-y-3" onSubmit={handleGenerate}>
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  API Key
                </p>
                <Input
                  type="password"
                  value={hfApiKey}
                  onChange={(event) => setHfApiKey(event.target.value)}
                  placeholder="hf_..."
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Model ID
                </p>
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
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Provider (Optional)
                </p>
                <Input
                  value={generationProvider}
                  onChange={(event) => setGenerationProvider(event.target.value)}
                  placeholder="novita or fastest"
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted-foreground">
                  Tip: paste model as <code>MiniMaxAI/MiniMax-M2.5:novita</code> to auto-fill
                  provider. Leave empty to use HF auto-routing.
                </p>
              </div>
              <Button className="w-full" type="submit" disabled={generationLoading}>
                {generationLoading ? "Generating..." : "Generate and Publish"}
              </Button>
              {generationError ? (
                <p className="text-xs text-destructive">{generationError}</p>
              ) : null}
              {generationSuccess ? (
                <p className="text-xs text-primary">{generationSuccess}</p>
              ) : null}
              {generationLogs.length > 0 && !generationLoading ? (
                <div className="space-y-1 rounded-lg border border-border/70 bg-secondary/20 p-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    Last Run Activity
                  </p>
                  <ul className="space-y-1 text-[11px] text-muted-foreground">
                    {generationLogs.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </form>
          </CardContent>
        </Card>

        <Card className="gap-4 border-border/70 bg-white/75 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Model Selection</CardTitle>
            <CardDescription>Pick the artifact to preview</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <ModelSelector
              options={entries}
              value={selectedModelId}
              onValueChange={handleModelChange}
              disabled={listLoading || !hasEntries}
            />
          </CardContent>
        </Card>

        <Card className="gap-4 border-border/70 bg-white/75 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Model Details</CardTitle>
            <CardDescription>Metadata for current preview</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{selectedEntry?.provider ?? "none"}</Badge>
              <Badge variant="secondary">{selectedEntry?.vendor ?? "none"}</Badge>
              <Badge variant="outline">{selectedEntry?.sourceType ?? "none"}</Badge>
            </div>
            <Separator />
            <div className="space-y-1 text-muted-foreground">
              <p>
                <span className="font-semibold text-foreground">Model ID:</span>{" "}
                {selectedEntry?.modelId ?? "N/A"}
              </p>
              <p>
                <span className="font-semibold text-foreground">Prompt:</span>{" "}
                {selectedEntry?.promptVersion ?? promptVersion}
              </p>
              <p>
                <span className="font-semibold text-foreground">Updated:</span>{" "}
                {selectedEntry ? formatTimestamp(selectedEntry.createdAt) : "N/A"}
              </p>
              <p>
                <span className="font-semibold text-foreground">Source:</span>{" "}
                {selectedEntry?.sourceRef ?? "N/A"}
              </p>
            </div>
          </CardContent>
        </Card>

        <PromptCard prompt={prompt} promptVersion={promptVersion} />
      </aside>

      <section className="min-h-[62vh] bg-white lg:min-h-0">
        <PreviewFrame
          html={html}
          title={selectedEntry ? `${selectedEntry.label} output` : "No selection"}
          loading={listLoading || previewLoading}
          errorMessage={errorMessage}
          generationLoading={generationLoading}
          generationStatus={generationStatus}
          generationLogs={generationLogs}
        />
      </section>
    </div>
  );
}
