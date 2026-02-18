import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CodeStreamPanel } from "@/components/code-stream-panel";

describe("CodeStreamPanel", () => {
  it("auto-scrolls while generation is streaming", async () => {
    const { rerender } = render(
      <CodeStreamPanel
        streamedHtml="<html><body>start</body></html>"
        activeFile="index.html"
        onActiveFileChange={() => undefined}
        generationLoading
        generationLogs={[]}
      />,
    );

    const scrollContainer = screen.getByTestId("code-stream-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    rerender(
      <CodeStreamPanel
        streamedHtml={"<html><body>start\n" + "line\n".repeat(80) + "</body></html>"}
        activeFile="index.html"
        onActiveFileChange={() => undefined}
        generationLoading
        generationLogs={[]}
      />,
    );

    await waitFor(() => {
      expect((scrollContainer as HTMLDivElement).scrollTop).toBe(640);
    });
  });

  it("renders syntax highlighted tokens for JavaScript output", () => {
    render(
      <CodeStreamPanel
        streamedHtml="<html><body><script>const total = 42;</script></body></html>"
        activeFile="script.js"
        onActiveFileChange={() => undefined}
        generationLoading={false}
        generationLogs={[]}
      />,
    );

    expect(screen.getByText("const")).toHaveClass("text-[#ff7b72]");
    expect(screen.getByText("42")).toHaveClass("text-[#79c0ff]");
  });
});
