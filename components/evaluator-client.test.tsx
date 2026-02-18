import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
let queryString = "model=minimax-m1";
let lastGenerateBody: {
  hfApiKey: string;
  modelId: string;
  provider?: string;
  billTo?: string;
} | null = null;
let generateMode: "success" | "nonJson504" = "success";
let artifact404ModelId: string | null = null;

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

const baseEntries = [
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
];

let currentEntries = [...baseEntries];
let currentHtml: Record<string, string> = {
  baseline: "<html><body>Baseline output</body></html>",
  "minimax-m1": "<html><body>MiniMax output</body></html>",
};

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/generate/hf" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          hfApiKey: string;
          modelId: string;
          provider?: string;
          billTo?: string;
        };
        lastGenerateBody = body;

        if (generateMode === "nonJson504") {
          return new Response("<html><body>Gateway Timeout</body></html>", {
            status: 504,
            headers: {
              "Content-Type": "text/html",
            },
          });
        }

        const modelId = body.modelId;
        const provider = body.provider ?? "auto";
        const generatedEntry = {
          modelId,
          label: modelId.split("/").at(-1) ?? modelId,
          provider: "huggingface",
          vendor: modelId.split("/")[0] ?? "unknown",
          sourceType: "model" as const,
          artifactPath: `data/artifacts/${modelId}/index.html`,
          promptVersion: "v1",
          createdAt: "2026-02-18T00:20:00.000Z",
          sourceRef: `huggingface:${modelId}:${provider}`,
        };

        const existingIndex = currentEntries.findIndex((entry) => entry.modelId === modelId);
        if (existingIndex >= 0) {
          currentEntries[existingIndex] = generatedEntry;
        } else {
          currentEntries.push(generatedEntry);
        }

        currentHtml[modelId] = "<html><body>Generated output</body></html>";

        return new Response(
          JSON.stringify({
            ok: true,
            entry: generatedEntry,
            generation: {
              usedModel: provider === "auto" ? modelId : `${modelId}:${provider}`,
              usedProvider: provider,
              attempts: [
                {
                  model: provider === "auto" ? modelId : `${modelId}:${provider}`,
                  provider,
                  status: "success",
                  retryable: false,
                  durationMs: 1000,
                },
              ],
            },
          }),
          {
            status: 201,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (url.startsWith("/api/artifacts?modelId=")) {
        const modelId = decodeURIComponent(url.split("=")[1] ?? "");
        if (modelId === artifact404ModelId) {
          return new Response(JSON.stringify({ error: "Artifact not found." }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        const entry = currentEntries.find((item) => item.modelId === modelId);
        if (!entry || !currentHtml[modelId]) {
          return new Response(JSON.stringify({ error: "Artifact not found." }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        return new Response(
          JSON.stringify({
            entry,
            html: currentHtml[modelId],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (url === "/api/artifacts") {
        return new Response(JSON.stringify({ entries: currentEntries }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }),
  );
}

describe("EvaluatorClient", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    lastGenerateBody = null;
    queryString = "model=minimax-m1";
    generateMode = "success";
    artifact404ModelId = null;
    window.history.replaceState({}, "", `/?${queryString}`);

    currentEntries = [...baseEntries];
    currentHtml = {
      baseline: "<html><body>Baseline output</body></html>",
      "minimax-m1": "<html><body>MiniMax output</body></html>",
    };

    mockFetch();
  });

  it("restores selection from model query parameter", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
    });

    expect(screen.getByText("minimax")).toBeInTheDocument();
  });

  it("changes the preview after selecting another model", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Baseline (Original)" }));

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(replaceMock).toHaveBeenCalledWith("/?model=baseline", { scroll: false });
  });

  it("submits hf generation and refreshes the model list", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_test_key");
    await user.type(
      screen.getByPlaceholderText("moonshotai/Kimi-K2-Instruct-0905"),
      "moonshotai/kimi-k2-instruct:novita",
    );
    expect(screen.getByPlaceholderText("novita or fastest")).toHaveValue("novita");
    await user.type(screen.getByPlaceholderText("huggingface"), "my-org");
    await user.click(screen.getByRole("button", { name: "Generate and Publish" }));

    await waitFor(() => {
      expect(screen.getByTitle("kimi-k2-instruct output")).toBeInTheDocument();
    });

    expect(screen.getByText("Saved and published kimi-k2-instruct.")).toBeInTheDocument();
    expect(lastGenerateBody).toMatchObject({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2-instruct",
      provider: "novita",
      billTo: "my-org",
    });
    expect(replaceMock).toHaveBeenCalledWith("/?model=moonshotai%2Fkimi-k2-instruct", {
      scroll: false,
    });
  });

  it("allows model-only generation without provider", async () => {
    queryString = "model=minimax-m1";
    window.history.replaceState({}, "", `/?${queryString}`);

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_test_key");
    await user.type(
      screen.getByPlaceholderText("moonshotai/Kimi-K2-Instruct-0905"),
      "moonshotai/kimi-k2-instruct",
    );
    await user.click(screen.getByRole("button", { name: "Generate and Publish" }));

    await waitFor(() => {
      expect(screen.getByTitle("kimi-k2-instruct output")).toBeInTheDocument();
    });

    expect(lastGenerateBody).toMatchObject({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2-instruct",
    });
    expect(lastGenerateBody).not.toHaveProperty("provider");
    expect(lastGenerateBody).not.toHaveProperty("billTo");
    expect(
      screen.getByText(/Attempt 1\/1: moonshotai\/kimi-k2-instruct \[auto\] ok/),
    ).toBeInTheDocument();
  });

  it("shows a deterministic error when generation returns non-JSON 504", async () => {
    generateMode = "nonJson504";

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_test_key");
    await user.type(
      screen.getByPlaceholderText("moonshotai/Kimi-K2-Instruct-0905"),
      "moonshotai/kimi-k2-instruct",
    );
    await user.click(screen.getByRole("button", { name: "Generate and Publish" }));

    await waitFor(() => {
      expect(
        screen.getByText("Generation timed out upstream. Try a faster model/provider or retry."),
      ).toBeInTheDocument();
    });

    expect(screen.getByTitle("MiniMax M1 output")).toBeInTheDocument();
  });

  it("shows a specific message when selected artifact returns 404", async () => {
    artifact404ModelId = "minimax-m1";

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByText("Artifact not available for this model yet.")).toBeInTheDocument();
    });
  });
});
