import { useEffect, useMemo, useRef } from "react";

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

type HighlightTokenType =
  | "plain"
  | "comment"
  | "keyword"
  | "string"
  | "number"
  | "property"
  | "tag";

interface HighlightSegment {
  text: string;
  type: HighlightTokenType;
}

const TOKEN_CLASS: Record<HighlightTokenType, string> = {
  plain: "text-[#c9d1d9]",
  comment: "text-[#8b949e]",
  keyword: "text-[#ff7b72]",
  string: "text-[#a5d6ff]",
  number: "text-[#79c0ff]",
  property: "text-[#d2a8ff]",
  tag: "text-[#7ee787]",
};

function tokenizeCode(
  code: string,
  pattern: RegExp,
  classify: (token: string) => HighlightSegment[],
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;

  for (const match of code.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;
    const token = match[0] ?? "";

    if (matchIndex > lastIndex) {
      segments.push({
        text: code.slice(lastIndex, matchIndex),
        type: "plain",
      });
    }

    segments.push(...classify(token));
    lastIndex = matchIndex + token.length;
  }

  if (lastIndex < code.length) {
    segments.push({
      text: code.slice(lastIndex),
      type: "plain",
    });
  }

  return segments;
}

function highlightHtmlTag(tagToken: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;

  for (const match of tagToken.matchAll(/"[^"]*"|'[^']*'/g)) {
    const matchIndex = match.index ?? 0;
    const token = match[0] ?? "";

    if (matchIndex > lastIndex) {
      segments.push({
        text: tagToken.slice(lastIndex, matchIndex),
        type: "tag",
      });
    }

    segments.push({
      text: token,
      type: "string",
    });
    lastIndex = matchIndex + token.length;
  }

  if (lastIndex < tagToken.length) {
    segments.push({
      text: tagToken.slice(lastIndex),
      type: "tag",
    });
  }

  return segments;
}

function highlightHtml(code: string): HighlightSegment[] {
  return tokenizeCode(
    code,
    /<!--[\s\S]*?-->|<\/?[a-zA-Z!][^>]*>/g,
    (token): HighlightSegment[] => {
      if (token.startsWith("<!--")) {
        return [{ text: token, type: "comment" }];
      }

      return highlightHtmlTag(token);
    },
  );
}

function highlightCss(code: string): HighlightSegment[] {
  return tokenizeCode(
    code,
    /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\da-fA-F]{3,8}\b|\b(?:@media|@keyframes|@supports|from|to)\b|[a-zA-Z-]+(?=\s*:)|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b/g,
    (token): HighlightSegment[] => {
      if (token.startsWith("/*")) {
        return [{ text: token, type: "comment" }];
      }

      if (token.startsWith('"') || token.startsWith("'")) {
        return [{ text: token, type: "string" }];
      }

      if (token.startsWith("@")) {
        return [{ text: token, type: "keyword" }];
      }

      if (/^[a-zA-Z-]+$/.test(token)) {
        return [{ text: token, type: "property" }];
      }

      if (/^#/.test(token) || /^\d/.test(token)) {
        return [{ text: token, type: "number" }];
      }

      return [{ text: token, type: "plain" }];
    },
  );
}

function highlightJavaScript(code: string): HighlightSegment[] {
  const jsKeywordPattern =
    /^(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|try|catch|finally|throw|await|async|import|from|export|default|typeof|instanceof)$/;

  return tokenizeCode(
    code,
    /\/\/.*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|try|catch|finally|throw|await|async|import|from|export|default|typeof|instanceof)\b|\b\d+(?:\.\d+)?\b/g,
    (token): HighlightSegment[] => {
      if (token.startsWith("//") || token.startsWith("/*")) {
        return [{ text: token, type: "comment" }];
      }

      if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
        return [{ text: token, type: "string" }];
      }

      if (jsKeywordPattern.test(token)) {
        return [{ text: token, type: "keyword" }];
      }

      if (/^\d/.test(token)) {
        return [{ text: token, type: "number" }];
      }

      return [{ text: token, type: "plain" }];
    },
  );
}

function highlightCode(file: CodeFileName, code: string): HighlightSegment[] {
  if (file === "styles.css") {
    return highlightCss(code);
  }

  if (file === "script.js") {
    return highlightJavaScript(code);
  }

  return highlightHtml(code);
}

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
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const displayCode = getDisplayCode(activeFile, streamedHtml).trim();
  const showPlaceholder = displayCode.length === 0;
  const highlightedCode = useMemo(
    () => highlightCode(activeFile, displayCode),
    [activeFile, displayCode],
  );

  useEffect(() => {
    if (!generationLoading || showPlaceholder) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [displayCode, generationLoading, showPlaceholder]);

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

      <div
        ref={scrollContainerRef}
        data-testid="code-stream-scroll"
        className="min-h-0 flex-1 overflow-auto bg-[#0d1117] dark:bg-[#0d1117]"
      >
        <pre className="min-h-full whitespace-pre-wrap px-4 py-4 font-mono text-xs leading-6 text-[#c9d1d9]">
          {showPlaceholder ? (
            <span className="text-[#484f58]">{getEmptyState(activeFile)}</span>
          ) : (
            highlightedCode.map((segment, index) => (
              <span key={`${segment.type}-${index}`} className={TOKEN_CLASS[segment.type]}>
                {segment.text}
              </span>
            ))
          )}
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
