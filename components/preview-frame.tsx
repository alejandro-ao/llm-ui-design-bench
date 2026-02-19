import { useState } from "react";
import { LoaderCircle } from "lucide-react";

interface PreviewFrameProps {
  html: string | null;
  title: string;
  loading: boolean;
  errorMessage: string | null;
  generationLoading?: boolean;
  generationStatus?: string | null;
}

export function PreviewFrame({
  html,
  title,
  loading,
  errorMessage,
  generationLoading = false,
  generationStatus,
}: PreviewFrameProps) {
  const defaultZoom = 85;
  const [previewZoom, setPreviewZoom] = useState(defaultZoom);
  const zoomScale = previewZoom / 100;
  const scaledFrameSize = 100 / zoomScale;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {generationLoading ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-background/80 px-6 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <LoaderCircle className="mt-0.5 size-4 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Generating...</p>
                <p className="text-xs text-muted-foreground">
                  {generationStatus ?? "Working on your request..."}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!generationLoading && loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background text-sm text-muted-foreground">
          Loading output...
        </div>
      ) : null}

      {!generationLoading && !loading && errorMessage ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background px-6 text-center text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {!generationLoading && !loading && !errorMessage && !html ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
          Output not available yet for this model.
        </div>
      ) : null}

      {!loading && !errorMessage && html ? (
        <>
          <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-md border border-border bg-background/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
            <label htmlFor="preview-zoom" className="text-muted-foreground">
              Zoom
            </label>
            <input
              id="preview-zoom"
              aria-label="Preview zoom"
              type="range"
              min={60}
              max={100}
              step={5}
              value={previewZoom}
              onChange={(event) => {
                setPreviewZoom(Number.parseInt(event.target.value, 10));
              }}
              className="h-1 w-24 accent-primary"
            />
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPreviewZoom(defaultZoom)}
              disabled={previewZoom === defaultZoom}
            >
              Reset
            </button>
            <span className="w-9 text-right font-mono text-[11px]">{previewZoom}%</span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
            <iframe
              title={title}
              sandbox="allow-scripts"
              srcDoc={html}
              className="absolute top-0 left-0 block border-0 bg-white"
              style={{
                width: `${scaledFrameSize}%`,
                height: `${scaledFrameSize}%`,
                transform: `scale(${zoomScale})`,
                transformOrigin: "top left",
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
