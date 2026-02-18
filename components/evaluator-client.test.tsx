import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
let queryString = "model=minimax-m1";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/",
}));

vi.mock("@/components/model-selector", () => ({
  ModelSelector: ({
    options,
    onValueChange,
    disabled,
  }: {
    options: Array<{ modelId: string; label: string }>;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.modelId}
          type="button"
          onClick={() => onValueChange(option.modelId)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

import { EvaluatorClient } from "@/components/evaluator-client";

const listPayload = {
  entries: [
    {
      modelId: "baseline",
      label: "Baseline (Original)",
      provider: "reference",
      vendor: "baseline",
      sourceType: "baseline",
      artifactPath: "data/artifacts/baseline/index.html",
      promptVersion: "v1",
      createdAt: "2026-02-18T00:00:00.000Z",
    },
    {
      modelId: "minimax-m1",
      label: "MiniMax M1",
      provider: "huggingface",
      vendor: "minimax",
      sourceType: "model",
      artifactPath: "data/artifacts/minimax-m1/index.html",
      promptVersion: "v1",
      createdAt: "2026-02-18T00:10:00.000Z",
    },
  ],
};

const htmlPayload = {
  baseline: "<html><body>Baseline output</body></html>",
  "minimax-m1": "<html><body>MiniMax output</body></html>",
};

describe("EvaluatorClient", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    window.history.replaceState({}, "", `/?${queryString}`);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.startsWith("/api/artifacts?modelId=")) {
          const modelId = url.split("=")[1] as "baseline" | "minimax-m1";
          return new Response(
            JSON.stringify({
              entry: listPayload.entries.find((entry) => entry.modelId === modelId),
              html: htmlPayload[modelId],
            }),
            { status: 200 },
          );
        }

        return new Response(JSON.stringify(listPayload), { status: 200 });
      }),
    );
  });

  it("restores selection from model query parameter", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByText("MiniMax M1 output")).toBeInTheDocument();
    });

    expect(screen.getByText("minimax")).toBeInTheDocument();
  });

  it("changes the preview after selecting another model", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByText("MiniMax M1 output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Baseline (Original)" }));

    await waitFor(() => {
      expect(screen.getByText("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(replaceMock).toHaveBeenCalledWith("/?model=baseline", { scroll: false });
  });
});
