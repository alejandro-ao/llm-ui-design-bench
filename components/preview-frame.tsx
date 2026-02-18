import { LoaderCircle } from "lucide-react";

interface PreviewFrameProps {
  html: string | null;
  title: string;
  loading: boolean;
  errorMessage: string | null;
  generationLoading?: boolean;
  generationStatus?: string | null;
  generationLogs?: string[];
}

export function PreviewFrame({
  html,
  title,
  loading,
  errorMessage,
  generationLoading = false,
  generationStatus,
  generationLogs = [],
}: PreviewFrameProps) {
  return (
    <div className="relative h-full min-h-[62vh] bg-white lg:min-h-0">
      {generationLoading ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-white/80 px-6 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border/80 bg-card/95 p-6 shadow-2xl shadow-black/10">
            <div className="flex items-start gap-3">
              <LoaderCircle className="mt-0.5 size-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-semibold text-foreground">Generating with Hugging Face</p>
                <p className="text-sm text-muted-foreground">
                  {generationStatus ?? "Working on your request..."}
                </p>
              </div>
            </div>
            {generationLogs.length > 0 ? (
              <div className="rounded-lg border border-border/70 bg-white/70 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Activity
                </p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {generationLogs.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!generationLoading && loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/70 text-sm text-muted-foreground">
          Loading artifact...
        </div>
      ) : null}

      {!generationLoading && !loading && errorMessage ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white px-6 text-center text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {!generationLoading && !loading && !errorMessage && !html ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white px-6 text-center text-sm text-muted-foreground">
          Artifact not available yet for this model.
        </div>
      ) : null}

      {!loading && !errorMessage && html ? (
        <iframe
          title={title}
          sandbox="allow-scripts"
          srcDoc={html}
          className="h-full min-h-[62vh] w-full bg-white lg:min-h-0"
        />
      ) : null}
    </div>
  );
}
