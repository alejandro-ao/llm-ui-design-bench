import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();

type GenerateRequestBody = {
  hfApiKey?: string;
  modelId: string;
  providers?: string[];
  billTo?: string;
  skillContent?: string;
  taskId?: string;
  taskContext?: unknown;
};

type StreamBehavior =
  | {
      kind: "success";
      html: string;
      streamedText?: string;
      attempts?: Array<{
        model: string;
        provider: string;
        status: "success";
        retryable: boolean;
        durationMs: number;
      }>;
    }
  | {
      kind: "error";
      message: string;
      attempts?: Array<{
        model: string;
        provider: string;
        status: "error";
        statusCode: number;
        retryable: boolean;
        durationMs: number;
        detail: string;
      }>;
    }
  | {
      kind: "nonJson504";
    };

interface SearchModelResult {
  modelId: string;
  label: string;
  vendor: string;
  providers: string[];
}

let oauthEnabled = true;
let oauthMode: "space" | "custom" = "custom";
let oauthConnected = false;
let oauthExpiresAt: number | null = null;
let baselineHtml = "<html><body>Baseline output</body></html>";
let generateRequests: GenerateRequestBody[] = [];
let streamBehaviors: Record<string, StreamBehavior> = {};

const SEARCH_CATALOG: SearchModelResult[] = [
  {
    modelId: "moonshotai/Kimi-K2.5",
    label: "Kimi-K2.5",
    vendor: "moonshotai",
    providers: ["novita", "hf-inference"],
  },
  {
    modelId: "minimax/MiniMax-M1",
    label: "MiniMax-M1",
    vendor: "minimax",
    providers: ["nebius", "fal-ai"],
  },
  {
    modelId: "deepseek-ai/DeepSeek-V3",
    label: "DeepSeek-V3",
    vendor: "deepseek-ai",
    providers: ["novita"],
  },
  {
    modelId: "qwen/Qwen2.5-Coder-32B-Instruct",
    label: "Qwen2.5-Coder-32B-Instruct",
    vendor: "qwen",
    providers: ["fireworks-ai"],
  },
  {
    modelId: "meta-llama/Llama-3.3-70B-Instruct",
    label: "Llama-3.3-70B-Instruct",
    vendor: "meta-llama",
    providers: ["together"],
  },
];

function encodeSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildSuccessStream(modelId: string, html: string, streamedText = html): Response {
  const provider = "auto";
  const resolvedAttempts = [
    {
      model: modelId,
      provider,
      status: "success" as const,
      retryable: false,
      durationMs: 900,
    },
  ];
  const events = [
    encodeSseEvent("meta", {
      modelId,
      provider,
      plannedAttempts: 1,
    }),
    encodeSseEvent("attempt", {
      attemptNumber: 1,
      totalAttempts: 1,
      model: modelId,
      provider,
      resetCode: false,
    }),
    encodeSseEvent("token", { text: streamedText.slice(0, Math.ceil(streamedText.length / 2)) }),
    encodeSseEvent("token", { text: streamedText.slice(Math.ceil(streamedText.length / 2)) }),
    encodeSseEvent("complete", {
      result: {
        modelId,
        label: modelId.split("/").at(-1) ?? modelId,
        provider: "huggingface",
        vendor: modelId.split("/")[0] ?? "unknown",
        html,
      },
      generation: {
        usedModel: modelId,
        usedProvider: provider,
        attempts: resolvedAttempts,
      },
    }),
    encodeSseEvent("done", {}),
  ].join("");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events));
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

function buildErrorStream(
  modelId: string,
  message: string,
  attempts: Extract<StreamBehavior, { kind: "error" }>["attempts"],
): Response {
  const provider = "auto";
  const resolvedAttempts =
    attempts ??
    [
      {
        model: modelId,
        provider,
        status: "error" as const,
        statusCode: 504,
        retryable: false,
        durationMs: 1200,
        detail: message,
      },
    ];

  const events = [
    encodeSseEvent("meta", {
      modelId,
      provider,
      plannedAttempts: 1,
    }),
    encodeSseEvent("attempt", {
      attemptNumber: 1,
      totalAttempts: 1,
      model: modelId,
      provider,
      resetCode: false,
    }),
    encodeSseEvent("error", {
      message,
      attempts: resolvedAttempts,
    }),
    encodeSseEvent("done", {}),
  ].join("");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events));
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/",
}));

import { EvaluatorClient } from "@/components/evaluator-client";

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const parsedUrl = new URL(url, "http://localhost");
      const pathname = parsedUrl.pathname;

      if (pathname === "/api/auth/hf/config" && method === "GET") {
        return new Response(
          JSON.stringify({
            enabled: oauthEnabled,
            mode: oauthMode,
            exchangeMethod: "client_secret",
            clientId: oauthEnabled ? "hf_client" : null,
            scopes: ["openid", "profile", "inference-api"],
            providerUrl: "https://huggingface.co",
            redirectUrl: "http://localhost/oauth/callback",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (pathname === "/api/auth/hf/session" && method === "GET") {
        return new Response(
          JSON.stringify({
            connected: oauthConnected,
            expiresAt: oauthConnected ? oauthExpiresAt : null,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (pathname === "/api/auth/hf/session" && method === "DELETE") {
        oauthConnected = false;
        oauthExpiresAt = null;
        return new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      if (pathname === "/api/artifacts" && parsedUrl.searchParams.get("modelId") === "baseline") {
        return new Response(
          JSON.stringify({
            entry: {
              modelId: "baseline",
              label: "Baseline (Original)",
            },
            html: baselineHtml,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (pathname === "/api/hf/models/search" && method === "GET") {
        const query = (parsedUrl.searchParams.get("q") ?? "").toLowerCase();
        const requestedLimit = Number.parseInt(parsedUrl.searchParams.get("limit") ?? "10", 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 10;

        if (query.trim().length < 2) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        const matches = SEARCH_CATALOG.filter((model) => {
          return (
            model.modelId.toLowerCase().includes(query) ||
            model.label.toLowerCase().includes(query)
          );
        }).slice(0, limit);

        return new Response(JSON.stringify({ models: matches }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      if (pathname === "/api/generate/hf/stream" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as GenerateRequestBody;
        generateRequests.push(body);

        const behavior = streamBehaviors[body.modelId] ?? {
          kind: "success" as const,
          html: `<html><body>${body.modelId} output</body></html>`,
        };

        if (behavior.kind === "nonJson504") {
          return new Response("<html><body>Gateway Timeout</body></html>", {
            status: 504,
            headers: {
              "Content-Type": "text/html",
            },
          });
        }

        if (behavior.kind === "error") {
          return buildErrorStream(body.modelId, behavior.message, behavior.attempts);
        }

        return buildSuccessStream(body.modelId, behavior.html, behavior.streamedText);
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

async function addModelFromSearch(query: string, expectedLabel: string) {
  const user = userEvent.setup();
  const searchInput = screen.getByLabelText("Search Hugging Face models");
  await user.clear(searchInput);
  await user.type(searchInput, query);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: new RegExp(expectedLabel, "i") })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: new RegExp(expectedLabel, "i") }));
}

async function saveSkillContent(content: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Add Skill|Edit Skill/i }));
  const textarea = screen.getByLabelText("Skill Content");
  await user.clear(textarea);
  await user.type(textarea, content);
  await user.click(screen.getByRole("button", { name: "Save Skill" }));
}

describe("EvaluatorClient", () => {
  beforeEach(() => {
    replaceMock.mockReset();

    oauthEnabled = true;
    oauthMode = "custom";
    oauthConnected = false;
    oauthExpiresAt = Math.floor(Date.now() / 1000) + 900;
    baselineHtml = "<html><body>Baseline output</body></html>";
    generateRequests = [];
    streamBehaviors = {};

    window.history.replaceState({}, "", "/");
    installFetchMock();
  });

  it("starts with baseline only and loads baseline preview", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Baseline \(Original\)/i })).toBeInTheDocument();
    expect(screen.getByText("No models selected yet.")).toBeInTheDocument();
  });

  it("adds the top search result when pressing Enter", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const searchInput = screen.getByLabelText("Search Hugging Face models");
    await user.type(searchInput, "kimi");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Kimi-K2.5/i })).toBeInTheDocument();
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Kimi-K2.5/i })).toBeInTheDocument();
    });

    expect(searchInput).toHaveValue("");
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  });

  it("enforces max 4 selected models", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await addModelFromSearch("minimax", "MiniMax-M1");
    await addModelFromSearch("deepseek", "DeepSeek-V3");
    await addModelFromSearch("qwen", "Qwen2.5-Coder-32B-Instruct");
    await addModelFromSearch("llama", "Llama-3.3-70B-Instruct");

    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(4);
    expect(screen.getByText("You can compare up to 4 models at once.")).toBeInTheDocument();
  });

  it("shows sidebar OAuth controls when enabled", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(screen.getByText("Hugging Face Auth")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect with Hugging Face" })).toBeInTheDocument();
  });

  it("hides OAuth controls when OAuth is unavailable", async () => {
    oauthEnabled = false;

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(screen.queryByText("Hugging Face Auth")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect with Hugging Face" })).not.toBeInTheDocument();
  });

  it("renders sanitized oauth error message from callback query params", async () => {
    window.history.replaceState(
      {},
      "",
      "/?oauth=exchange_failed&oauth_error=Unable%20to%20complete%20Hugging%20Face%20OAuth%20exchange%3A%20Invalid%20authorization%20code",
    );

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Unable to complete Hugging Face OAuth exchange: Invalid authorization code"),
    ).toBeInTheDocument();
  });

  it("does not show OAuth success when callback status is connected but no session is available", async () => {
    window.history.replaceState({}, "", "/?oauth=connected");
    oauthConnected = false;

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled();
    });

    expect(screen.queryByText("Connected with Hugging Face OAuth.")).not.toBeInTheDocument();
  });

  it("requires manual API key when OAuth is unavailable", async () => {
    oauthEnabled = false;
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Add your Hugging Face API key to run generation.")).toBeInTheDocument();
    });
  });

  it("includes saved skill content in generation requests", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi session output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await saveSkillContent("  Use magazine-style typography and dramatic spacing.  ");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      hfApiKey: "hf_manual_key",
      providers: ["novita", "hf-inference"],
      skillContent: "Use magazine-style typography and dramatic spacing.",
    });
  });

  it("sends typed task payload for multistep form generations", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi multistep output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Multi-step Form/i }));

    await addModelFromSearch("kimi", "Kimi-K2.5");

    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      providers: ["novita", "hf-inference"],
      taskId: "multistep_form",
      taskContext: {
        formVariant: "saas_onboarding",
      },
    });
  });

  it("keeps models and skills isolated per task", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await saveSkillContent("HTML redesign skill.");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Clone Website/i }));

    expect(screen.getByText("No models selected yet.")).toBeInTheDocument();
    expect(screen.getByText("No skill attached.")).toBeInTheDocument();

    await addModelFromSearch("minimax", "MiniMax-M1");
    await saveSkillContent("Clone task skill.");

    await user.click(screen.getByRole("button", { name: /HTML to HTML Redesign/i }));

    await waitFor(() => {
      expect(screen.getAllByText("moonshotai/Kimi-K2.5").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Skill attached • 20 chars")).toBeInTheDocument();
    expect(screen.queryByText("minimax/MiniMax-M1")).not.toBeInTheDocument();
  });

  it("clearing skill removes it from subsequent generation requests", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi session output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await saveSkillContent("Use strong asymmetry and clean card rhythm.");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    expect(generateRequests[0]?.skillContent).toBe("Use strong asymmetry and clean card rhythm.");

    await user.click(screen.getByRole("button", { name: /Add Skill|Edit Skill/i }));
    await user.click(screen.getByRole("button", { name: "Clear Skill" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(generateRequests).toHaveLength(2);
    });

    expect(generateRequests[1]).not.toHaveProperty("skillContent");
  });

  it("blocks saving skill content over 8000 characters", async () => {
    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add Skill|Edit Skill/i }));
    const textarea = screen.getByLabelText("Skill Content");
    fireEvent.change(textarea, { target: { value: "x".repeat(8001) } });
    await user.click(screen.getByRole("button", { name: "Save Skill" }));

    expect(screen.getByText("Skill must be 8000 characters or fewer.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("runs sequential generation for selected models and shows final preview", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi session output</body></html>",
    };
    streamBehaviors["minimax/MiniMax-M1"] = {
      kind: "success",
      html: "<!doctype html><html><body>MiniMax session output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await addModelFromSearch("minimax", "MiniMax-M1");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 2 model outputs in this session only.")).toBeInTheDocument();
    });

    expect(generateRequests).toHaveLength(2);
    expect(generateRequests[0]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      hfApiKey: "hf_manual_key",
    });
    expect(generateRequests[1]).toMatchObject({
      modelId: "minimax/MiniMax-M1",
      hfApiKey: "hf_manual_key",
    });

    await waitFor(() => {
      expect(screen.getByTitle("MiniMax-M1 output")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/MiniMax session output/i)).toBeInTheDocument();
  });

  it("replaces fenced streamed text with final extracted html on completion", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Clean final html</body></html>",
      streamedText:
        "```html\n<!doctype html><html><body>Clean final html</body></html>\n```",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText(/Clean final html/i)).toBeInTheDocument();
    expect(screen.queryByText("```")).not.toBeInTheDocument();
  });

  it("continues remaining models when one generation fails", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "error",
      message: "Provider timeout from upstream.",
    };
    streamBehaviors["deepseek-ai/DeepSeek-V3"] = {
      kind: "success",
      html: "<!doctype html><html><body>DeepSeek success output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");
    await addModelFromSearch("deepseek", "DeepSeek-V3");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "1 of 2 model generations failed. Completed outputs are available for the rest.",
        ),
      ).toBeInTheDocument();
    });

    expect(generateRequests).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /Kimi-K2.5/i }));
    await waitFor(() => {
      expect(screen.getByText("Provider timeout from upstream.")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /DeepSeek-V3/i }));
    await waitFor(() => {
      expect(screen.getByTitle("DeepSeek-V3 output")).toBeInTheDocument();
    });
  });

  it("shows OAuth connected state and allows disconnect", async () => {
    oauthConnected = true;

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    expect(screen.getAllByText(/Token expires/).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "Disconnect Hugging Face" })[0]);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Connect with Hugging Face" }).length).toBeGreaterThan(0);
    });
  });

  it("submits generation without manual key when oauth is connected", async () => {
    oauthConnected = true;

    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi oauth output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      providers: ["novita", "hf-inference"],
    });
    expect(generateRequests[0]).not.toHaveProperty("hfApiKey");
  });

  it("retains manual API key across multiple generation runs in the same session", async () => {
    streamBehaviors["moonshotai/Kimi-K2.5"] = {
      kind: "success",
      html: "<!doctype html><html><body>Kimi run output</body></html>",
    };

    render(<EvaluatorClient prompt="Prompt" promptVersion="v1" />);

    await waitFor(() => {
      expect(screen.getByTitle("Baseline (Original) output")).toBeInTheDocument();
    });

    await addModelFromSearch("kimi", "Kimi-K2.5");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.type(screen.getByPlaceholderText("hf_..."), "hf_manual_key");
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 1 model output in this session only.")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Generate Selected" }));
    await user.click(screen.getByRole("button", { name: "Generate Selected Models" }));

    await waitFor(() => {
      expect(generateRequests).toHaveLength(2);
    });

    expect(generateRequests[0]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      hfApiKey: "hf_manual_key",
    });
    expect(generateRequests[1]).toMatchObject({
      modelId: "moonshotai/Kimi-K2.5",
      hfApiKey: "hf_manual_key",
    });
  });
});
