import { Badge } from "@/components/ui/badge";

export type CodeFileName = "index.html" | "styles.css" | "script.js";

interface CodeStreamPanelProps {
  streamedHtml: string;
  activeFile: CodeFileName;
  onActiveFileChange: (next: CodeFileName) => void;
  generationLoading: boolean;
  generationStatus?: string | null;
  generationLogs: string[];
  generationError?: string | null;
}

const FILE_ORDER: CodeFileName[] = ["index.html", "styles.css", "script.js"];

function extractStyleCode(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  return blocks.map((block) => block[1]?.trim() ?? "").filter(Boolean).join("\n\n");
}

function extractInlineScriptCode(html: string): string {
  const blocks = [
    ...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
  ];
  return blocks.map((block) => block[1]?.trim() ?? "").filter(Boolean).join("\n\n");
}

function getDisplayCode(file: CodeFileName, html: string): string {
  if (file === "styles.css") {
    return extractStyleCode(html);
  }

  if (file === "script.js") {
    return extractInlineScriptCode(html);
  }

  return html;
}

function getEmptyState(file: CodeFileName): string {
  if (file === "styles.css") {
    return "No closed <style> blocks streamed yet.";
  }

  if (file === "script.js") {
    return "No closed inline <script> blocks streamed yet.";
  }

  return "Streaming output will appear here.";
}

export function CodeStreamPanel({
  streamedHtml,
  activeFile,
  onActiveFileChange,
  generationLoading,
  generationStatus,
  generationLogs,
  generationError,
}: CodeStreamPanelProps) {
  const displayCode = getDisplayCode(activeFile, streamedHtml).trim();
  const showPlaceholder = displayCode.length === 0;

  return (
    <div className="flex h-full min-h-[62vh] flex-col lg:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-4 py-2">
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {FILE_ORDER.map((file) => {
            const isActive = activeFile === file;
            return (
              <button
                key={file}
                type="button"
                onClick={() => onActiveFileChange(file)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {file}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {generationLoading ? <Badge variant="default">streaming</Badge> : null}
          {generationError ? <Badge variant="destructive">error</Badge> : null}
          {generationStatus ? (
            <p className="text-xs text-muted-foreground">{generationStatus}</p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#0d1117] dark:bg-[#0d1117]">
        <pre className="min-h-full whitespace-pre-wrap px-4 py-4 font-mono text-xs leading-6 text-[#c9d1d9]">
          {showPlaceholder ? (
            <span className="text-[#484f58]">{getEmptyState(activeFile)}</span>
          ) : displayCode}
        </pre>
      </div>

      <div className="border-t border-border bg-sidebar px-4 py-2.5">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Activity
        </p>
        {generationLogs.length === 0 ? (
          <p className="text-xs text-muted-foreground/50">No events yet.</p>
        ) : (
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {generationLogs.map((entry, index) => (
              <li key={`${entry}-${index}`}>{entry}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
