import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreviewFrame } from "@/components/preview-frame";

describe("PreviewFrame", () => {
  it("shows empty state when no html exists", () => {
    render(
      <PreviewFrame html={null} title="Empty" loading={false} errorMessage={null} />,
    );

    expect(screen.getByText("Artifact not available yet for this model.")).toBeInTheDocument();
  });

  it("shows generation overlay activity in main content", () => {
    render(
      <PreviewFrame
        html="<html><body>preview</body></html>"
        title="Generated"
        loading={false}
        errorMessage={null}
        generationLoading
        generationStatus="Contacting Hugging Face provider..."
        generationLogs={["12:00:00 Started generation"]}
      />,
    );

    expect(screen.getByText("Generating with Hugging Face")).toBeInTheDocument();
    expect(screen.getByText("Contacting Hugging Face provider...")).toBeInTheDocument();
    expect(screen.getByText("12:00:00 Started generation")).toBeInTheDocument();
  });
});
