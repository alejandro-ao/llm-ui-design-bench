"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ModelSelector, type ModelOption } from "@/components/model-selector";
import { PreviewFrame } from "@/components/preview-frame";
import { PromptCard } from "@/components/prompt-card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface ArtifactSummary extends ModelOption {
  artifactPath: string;
  promptVersion: string;
  createdAt: string;
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
        const response = await fetch(`/api/artifacts?modelId=${encodeURIComponent(selectedModelId)}`, {
          cache: "no-store",
        });

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
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-6">
          <ModelSelector
            options={entries}
            value={selectedModelId}
            onValueChange={handleModelChange}
            disabled={listLoading || !hasEntries}
          />

          <div className="rounded-xl border border-border/70 bg-white/60 p-4">
            <p className="text-sm font-semibold text-foreground">Current Selection</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="outline">{selectedEntry?.provider ?? "none"}</Badge>
              <Badge variant="secondary">{selectedEntry?.vendor ?? "none"}</Badge>
              <Badge variant="outline">{selectedEntry?.sourceType ?? "none"}</Badge>
            </div>
            <Separator className="my-4" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Last updated: {selectedEntry ? formatTimestamp(selectedEntry.createdAt) : "N/A"}
            </p>
          </div>

          <PromptCard prompt={prompt} promptVersion={promptVersion} />
        </div>

        <PreviewFrame
          html={html}
          title={selectedEntry ? `${selectedEntry.label} output` : "No selection"}
          loading={listLoading || previewLoading}
          errorMessage={errorMessage}
        />
      </div>
    </div>
  );
}
