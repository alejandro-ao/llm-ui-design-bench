import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
let queryString = "model=minimax-m1";
let lastGenerateBody: {
  hfApiKey: string;
  modelId: string;
  provider?: string;
} | null = null;

function encodeSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

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

describe("EvaluatorClient", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    lastGenerateBody = null;
    window.history.replaceState({}, "", `/?${queryString}`);

    const currentEntries = [...baseEntries];
    const currentHtml: Record<string, string> = {
      baseline: "<html><body>Baseline output</body></html>",
      "minimax-m1": "<html><body>MiniMax output</body></html>",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";

        if (url === "/api/generate/hf/stream" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as {
            hfApiKey: string;
            modelId: string;
            provider?: string;
          };
          lastGenerateBody = body;

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

          const streamPayload = [
            encodeSseEvent("meta", {
              modelId,
              provider: body.provider ?? null,
              plannedAttempts: 1,
            }),
            encodeSseEvent("attempt", {
              attemptNumber: 1,
              totalAttempts: 1,
              model: provider === "auto" ? modelId : `${modelId}:${provider}`,
              provider,
              resetCode: false,
            }),
            encodeSseEvent("token", { text: "<!doctype html><html><body>Generated " }),
            encodeSseEvent("token", { text: "output</body></html>" }),
            encodeSseEvent("complete", {
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
            encodeSseEvent("done", {}),
          ].join("");

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(streamPayload));
              controller.close();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        }

        if (url.startsWith("/api/artifacts?modelId=")) {
          const modelId = decodeURIComponent(url.split("=")[1] ?? "");
          return new Response(
            JSON.stringify({
              entry: currentEntries.find((entry) => entry.modelId === modelId),
              html: currentHtml[modelId],
            }),
            { status: 200 },
          );
        }

        if (url === "/api/artifacts") {
          return new Response(JSON.stringify({ entries: currentEntries }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }),
    );
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
    await user.click(screen.getByRole("button", { name: "Generate and Publish" }));

    await waitFor(() => {
      expect(screen.getByTitle("kimi-k2-instruct output")).toBeInTheDocument();
    });

    expect(screen.getByText("Saved and published kimi-k2-instruct.")).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/?model=moonshotai%2Fkimi-k2-instruct", {
      scroll: false,
    });

    await user.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/Generated output/)).toBeInTheDocument();
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
    expect(
      screen.getByText(/Attempt 1\/1: moonshotai\/kimi-k2-instruct \[auto\] ok/),
    ).toBeInTheDocument();
  });
});
