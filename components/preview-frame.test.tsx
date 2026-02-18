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
});
