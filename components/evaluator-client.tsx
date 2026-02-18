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

interface GenerateHfResponse {
  ok: boolean;
  entry: ArtifactSummary;
}

interface ApiErrorResponse {
  error?: string;
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
  const [generationLoading, setGenerationLoading] = useState(false);
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
          throw new Error("Unable to load artifact preview.");
        }

        const payload = (await response.json()) as ArtifactDetailResponse;

        if (!active) {
          return;
        }

        setHtml(payload.html);
      } catch {
        if (active) {
          setHtml(null);
          setErrorMessage("Unable to load this artifact preview.");
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

      const modelId = generationModelId.trim();
      const apiKey = hfApiKey.trim();

      if (!apiKey) {
        setGenerationError("Add your Hugging Face API key to run generation.");
        return;
      }

      if (!modelId) {
        setGenerationError("Add a model ID to generate an artifact.");
        return;
      }

      setGenerationLoading(true);

      try {
        const response = await fetch("/api/generate/hf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            hfApiKey: apiKey,
            modelId,
          }),
        });

        const payload = (await response.json()) as GenerateHfResponse & ApiErrorResponse;

        if (!response.ok) {
          throw new Error(payload.error ?? "Generation failed.");
        }

        const nextModelId = payload.entry.modelId;

        await loadEntries(nextModelId);
        setSelectedModelId(nextModelId);
        updateModelQuery(nextModelId);

        setGenerationSuccess(`Saved and published ${payload.entry.label}.`);
        setHfApiKey("");
      } catch (error) {
        setGenerationError((error as Error).message);
      } finally {
        setGenerationLoading(false);
      }
    },
    [generationModelId, hfApiKey, loadEntries, updateModelQuery],
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
                  onChange={(event) => setGenerationModelId(event.target.value)}
                  placeholder="moonshotai/Kimi-K2-Instruct-0905"
                  autoComplete="off"
                />
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
        />
      </section>
    </div>
  );
}
