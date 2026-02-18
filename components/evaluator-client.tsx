"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ModelSelector, type ModelOption } from "@/components/model-selector";
import { PreviewFrame } from "@/components/preview-frame";
import { PromptCard } from "@/components/prompt-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.modelId === selectedModelId) ?? null,
    [entries, selectedModelId],
  );

  useEffect(() => {
    let active = true;

    const loadEntries = async () => {
      setListLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch("/api/artifacts", { cache: "no-store" });
        const payload = (await response.json()) as ArtifactsListResponse;

        if (!response.ok) {
          throw new Error("Unable to load artifact list.");
        }

        if (!active) {
          return;
        }

        setEntries(payload.entries);

        const modelFromQuery =
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("model");
        const modelExists = payload.entries.some((entry) => entry.modelId === modelFromQuery);
        const fallbackModelId = pickDefaultModelId(payload.entries);

        setSelectedModelId(modelExists && modelFromQuery ? modelFromQuery : fallbackModelId);
      } catch {
        if (active) {
          setErrorMessage("Unable to load artifacts right now.");
          setEntries([]);
          setSelectedModelId("");
        }
      } finally {
        if (active) {
          setListLoading(false);
        }
      }
    };

    void loadEntries();

    return () => {
      active = false;
    };
  }, []);

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
      const params = new URLSearchParams(
        typeof window === "undefined" ? "" : window.location.search,
      );
      params.set("model", nextModelId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  const hasEntries = entries.length > 0;

  return (
    <div className="grid h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-xl shadow-black/10 lg:grid-cols-[340px_minmax(0,1fr)]">
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
