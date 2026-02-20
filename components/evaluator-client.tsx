"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { CodeStreamPanel, type CodeFileName } from "@/components/code-stream-panel";
import { PreviewFrame } from "@/components/preview-frame";
import { PromptCard } from "@/components/prompt-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAX_SKILL_CONTENT_CHARS } from "@/lib/prompt";
import {
  getProviderLabel,
  isProviderId,
  PROVIDER_MODEL_PRESETS,
  PROVIDER_OPTIONS,
  type ProviderId,
} from "@/lib/providers";
import {
  buildTaskPrompt,
  DEFAULT_TASK_ID,
  getImageToCodeReference,
  getTaskDefinition,
  IMAGE_TO_CODE_REFERENCES,
  listTaskOptions,
  resolveAssetUrl,
  type ImageToCodeReference,
  type TaskContext,
  type TaskId,
} from "@/lib/tasks";
import type {
  HfGenerationStreamAttemptPayload,
  HfGenerationStreamCompletePayload,
  HfGenerationStreamErrorPayload,
  HfGenerationStreamLogPayload,
  HfGenerationStreamMetaPayload,
  HfGenerationStreamTokenPayload,
} from "@/lib/hf-stream-events";

const BASELINE_MODEL_ID = "baseline";
const MAX_SELECTED_MODELS = 4;
const SKILL_TOO_LONG_MESSAGE = `Skill must be ${MAX_SKILL_CONTENT_CHARS} characters or fewer.`;
const OAUTH_UNAVAILABLE_MESSAGE =
  "OAuth is not configured on this deployment. For Hugging Face Spaces, add `hf_oauth: true` to README metadata and redeploy. You can still use API key fallback.";
const OAUTH_SECRET_MISCONFIGURED_MESSAGE =
  "OAuth session storage is misconfigured. Set HF_SESSION_COOKIE_SECRET (recommended) or ensure OAuth client secret env vars are available, then redeploy.";
const OAUTH_SESSION_NOT_PERSISTED_MESSAGE =
  "Hugging Face OAuth completed, but no active OAuth session is available. If you are in the embedded Spaces page, open the direct `*.hf.space` URL and reconnect.";
const PROVIDER_KEY_REQUIRED_MESSAGE: Record<Exclude<ProviderId, "huggingface">, string> = {
  openai: "Add your OpenAI API key to run generation.",
  anthropic: "Add your Anthropic API key to run generation.",
  google: "Add your Google API key to run generation.",
};
const TASK_OPTIONS = listTaskOptions();
const TASK_IDS = TASK_OPTIONS.map((task) => task.id);
const DEFAULT_IMAGE_REFERENCE_ID = IMAGE_TO_CODE_REFERENCES[0]?.id ?? "figma_landing";

type MainPanelTab = "code" | "app";
type SessionModelStatus = "baseline" | "queued" | "generating" | "done" | "error";

interface ArtifactBaselineResponse {
  entry: {
    modelId: string;
    label: string;
  };
  html: string;
}

interface SearchModelResult {
  modelId: string;
  label: string;
  vendor: string;
  providers: string[];
}

interface SearchModelsResponse {
  models: SearchModelResult[];
}

interface OAuthConfigResponse {
  enabled: boolean;
  mode: "space" | "custom";
  exchangeMethod: "client_secret" | "pkce";
  clientId: string | null;
  scopes: string[];
  providerUrl: string;
  redirectUrl: string;
}

interface OAuthSessionResponse {
  connected: boolean;
  expiresAt?: number | null;
}

interface OAuthStateSnapshot {
  config: OAuthConfigResponse | null;
  connected: boolean;
  expiresAt: number | null;
}

interface GenerationAttempt {
  model: string;
  provider: string;
  status: "success" | "error";
  statusCode?: number;
  retryable: boolean;
  durationMs: number;
  detail?: string;
}

interface SessionModel {
  modelId: string;
  label: string;
  vendor: string;
  provider: ProviderId | "reference";
  sourceType: "baseline" | "model";
  providers: string[];
  status: SessionModelStatus;
  streamedHtml: string;
  finalHtml: string | null;
  logs: string[];
  attempts: GenerationAttempt[];
  error: string | null;
}

interface EvaluatorClientProps {
  prompt?: string;
  promptVersion?: string;
}

type TaskModelMap = Record<TaskId, SessionModel[]>;
type TaskStringMap = Record<TaskId, string>;
type TaskNullableStringMap = Record<TaskId, string | null>;
type TaskBooleanMap = Record<TaskId, boolean>;
type TaskProviderMap = Record<TaskId, ProviderId>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTaskMap<T>(factory: (taskId: TaskId) => T): Record<TaskId, T> {
  return TASK_IDS.reduce((accumulator, taskId) => {
    accumulator[taskId] = factory(taskId);
    return accumulator;
  }, {} as Record<TaskId, T>);
}

function buildReferenceHtml(
  title: string,
  description: string,
  mediaUrl?: string,
): string {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeMediaUrl = mediaUrl ? escapeHtml(mediaUrl) : null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #dbe3ef;
      --accent: #0f172a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background: radial-gradient(circle at top right, #e2ecff 0%, var(--bg) 38%);
      color: var(--text);
      padding: 32px;
    }
    .shell {
      max-width: 1100px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 28px;
      box-shadow: 0 24px 50px rgba(15, 23, 42, 0.08);
    }
    h1 {
      margin: 0;
      font-size: 2rem;
      letter-spacing: -0.02em;
    }
    p {
      margin: 14px 0 0;
      color: var(--muted);
      line-height: 1.6;
      max-width: 70ch;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      margin-top: 16px;
      font-size: 12px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 12px;
      background: #f8fbff;
    }
    .frame {
      margin-top: 24px;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: #eef2f7;
      min-height: 220px;
      display: grid;
      place-items: center;
    }
    img {
      width: 100%;
      height: auto;
      object-fit: cover;
      display: block;
    }
    .placeholder {
      padding: 28px;
      color: #64748b;
      text-align: center;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>${safeTitle}</h1>
    <p>${safeDescription}</p>
    <span class="badge">Task reference</span>
    <section class="frame">
      ${
        safeMediaUrl
          ? `<img src="${safeMediaUrl}" alt="${safeTitle}" />`
          : '<div class="placeholder">Generate a model output to preview this task.</div>'
      }
    </section>
  </main>
</body>
</html>`;
}

function formatOAuthExpiry(value: number | null): string {
  if (!value) {
    return "Session token has no explicit expiry.";
  }

  return `Token expires ${new Date(value * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function formatAttemptLogLine(
  attempt: GenerationAttempt,
  index: number,
  total: number,
): string {
  const status = attempt.status === "success" ? "ok" : "error";
  const statusCode = attempt.statusCode ? ` (${attempt.statusCode})` : "";
  const retrySuffix = attempt.retryable ? " retrying..." : "";
  return `Attempt ${index + 1}/${total}: ${attempt.model} [${attempt.provider}] ${status}${statusCode}${retrySuffix}`;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("application/json");
}

function getGenerationStatusMessage(status: number): string {
  if (status === 504 || status === 408) {
    return "Generation timed out upstream. Try a faster model/provider or retry.";
  }

  if (status === 429) {
    return "Generation was rate limited. Retry in a moment.";
  }

  if (status >= 500) {
    return "Generation failed due to an upstream provider error. Retry shortly.";
  }

  return `Generation failed with status ${status}.`;
}

function getOAuthConnectErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (normalized.includes("missing clientid")) {
    return OAUTH_UNAVAILABLE_MESSAGE;
  }

  if (normalized.includes("permission") || normalized.includes("navigation")) {
    return "Unable to start Hugging Face OAuth from this embedded view. Open the direct `*.hf.space` URL and retry.";
  }

  return "Unable to start Hugging Face OAuth. Try again.";
}

function parseSseEventBlock(
  block: string,
): { event: string; payload: unknown } | null {
  const normalizedBlock = block.replace(/\r/g, "");
  const lines = normalizedBlock.split("\n");

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawPayload = dataLines.join("\n");

  try {
    const payload = JSON.parse(rawPayload) as unknown;
    return {
      event: eventName,
      payload,
    };
  } catch {
    return null;
  }
}

function normalizeProviderCandidates(providers: string[]): string[] {
  const unique = new Set<string>();

  for (const rawProvider of providers) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider || provider === "auto") {
      continue;
    }

    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
      continue;
    }

    unique.add(provider);
    if (unique.size >= 8) {
      break;
    }
  }

  return [...unique];
}

function buildInitialBaselineModel(options?: {
  label?: string;
  html?: string | null;
}): SessionModel {
  const html = options?.html ?? null;

  return {
    modelId: BASELINE_MODEL_ID,
    label: options?.label ?? "Baseline (Original)",
    vendor: "baseline",
    provider: "reference",
    sourceType: "baseline",
    providers: [],
    status: "baseline",
    streamedHtml: html ?? "",
    finalHtml: html,
    logs: [],
    attempts: [],
    error: null,
  };
}

function getStatusBadge(status: SessionModelStatus) {
  if (status === "generating") {
    return <Badge variant="default">generating</Badge>;
  }

  if (status === "done") {
    return <Badge variant="secondary">done</Badge>;
  }

  if (status === "error") {
    return <Badge variant="destructive">error</Badge>;
  }

  if (status === "queued") {
    return <Badge variant="outline">queued</Badge>;
  }

  return <Badge variant="outline">baseline</Badge>;
}

function buildInitialTaskModels(): TaskModelMap {
  const defaultImageReference = getImageToCodeReference(DEFAULT_IMAGE_REFERENCE_ID);

  return {
    html_redesign: [buildInitialBaselineModel()],
    multistep_form: [
      buildInitialBaselineModel({
        label: "Task Reference (SaaS Onboarding)",
        html: buildReferenceHtml(
          "Multi-step SaaS Onboarding",
          "Required sections: Account, Company, Team Invite, Plan & Billing, and Review & Submit. Interaction and style are model-defined.",
        ),
      }),
    ],
    image_to_code: [
      buildInitialBaselineModel({
        label: `Reference Mockup (${defaultImageReference.label})`,
        html: buildReferenceHtml(
          "Image to Code Reference",
          defaultImageReference.description,
          defaultImageReference.assetPath,
        ),
      }),
    ],
  };
}

export function EvaluatorClient(_props: EvaluatorClientProps) {
  void _props;
  const router = useRouter();
  const pathname = usePathname();

  const [activeTaskId, setActiveTaskId] = useState<TaskId>(DEFAULT_TASK_ID);
  const [activeProviderByTask, setActiveProviderByTask] = useState<TaskProviderMap>(() =>
    buildTaskMap(() => "huggingface"),
  );
  const [sessionModelsByTask, setSessionModelsByTask] = useState<TaskModelMap>(() =>
    buildInitialTaskModels(),
  );
  const [selectedModelIdByTask, setSelectedModelIdByTask] = useState<TaskStringMap>(() =>
    buildTaskMap(() => BASELINE_MODEL_ID),
  );
  const [baselineLoadingByTask, setBaselineLoadingByTask] = useState<TaskBooleanMap>(() =>
    buildTaskMap((taskId) => taskId === "html_redesign"),
  );
  const [baselineErrorByTask, setBaselineErrorByTask] = useState<TaskNullableStringMap>(() =>
    buildTaskMap(() => null),
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchModelResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [providerPresetByTask, setProviderPresetByTask] = useState<TaskNullableStringMap>(() =>
    buildTaskMap(() => null),
  );
  const [skillContentByTask, setSkillContentByTask] = useState<TaskStringMap>(() =>
    buildTaskMap(() => ""),
  );
  const [skillDraft, setSkillDraft] = useState("");
  const [isSkillModalOpen, setIsSkillModalOpen] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [activeImageReferenceId, setActiveImageReferenceId] =
    useState<ImageToCodeReference["id"]>(DEFAULT_IMAGE_REFERENCE_ID);
  const [clientOrigin, setClientOrigin] = useState("http://localhost");

  const [hfApiKey, setHfApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [generationBillTo, setGenerationBillTo] = useState("");
  const [generationLoading, setGenerationLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSuccess, setGenerationSuccess] = useState<string | null>(null);
  const [activeGeneratingTaskId, setActiveGeneratingTaskId] = useState<TaskId | null>(null);
  const [activeGeneratingModelId, setActiveGeneratingModelId] = useState<string | null>(null);

  const [oauthConfig, setOauthConfig] = useState<OAuthConfigResponse | null>(null);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [oauthExpiresAt, setOauthExpiresAt] = useState<number | null>(null);
  const [oauthStatusLoading, setOauthStatusLoading] = useState(true);
  const [oauthActionLoading, setOauthActionLoading] = useState(false);
  const [oauthUiError, setOauthUiError] = useState<string | null>(null);
  const autoOAuthAttemptedRef = useRef(false);
  const autoOAuthSuppressedRef = useRef(false);

  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [activeCodeFile, setActiveCodeFile] = useState<CodeFileName>("index.html");
  const [activeMainTab, setActiveMainTab] = useState<MainPanelTab>("app");

  const sessionModels = sessionModelsByTask[activeTaskId];
  const activeProvider = activeProviderByTask[activeTaskId];
  const selectedModelId = selectedModelIdByTask[activeTaskId];
  const baselineLoading = baselineLoadingByTask[activeTaskId];
  const baselineError = baselineErrorByTask[activeTaskId];
  const providerPreset = providerPresetByTask[activeTaskId];
  const skillContent = skillContentByTask[activeTaskId];
  const activeTaskDefinition = getTaskDefinition(activeTaskId);
  const selectedImageReference = useMemo(
    () => getImageToCodeReference(activeImageReferenceId),
    [activeImageReferenceId],
  );
  const activeTaskContext = useMemo((): TaskContext => {
    if (activeTaskId === "html_redesign") {
      return {} as Record<string, never>;
    }

    if (activeTaskId === "multistep_form") {
      return {
        formVariant: "saas_onboarding",
      };
    }

    if (activeTaskId === "image_to_code") {
      return {
        imageId: selectedImageReference.id,
        imageUrl: resolveAssetUrl(clientOrigin, selectedImageReference.assetPath),
      };
    }

    return {
      imageId: selectedImageReference.id,
      imageUrl: resolveAssetUrl(clientOrigin, selectedImageReference.assetPath),
    };
  }, [activeTaskId, clientOrigin, selectedImageReference]);
  const activePrompt = useMemo(
    () => buildTaskPrompt(activeTaskId, activeTaskContext),
    [activeTaskContext, activeTaskId],
  );
  const activeProviderPresets = useMemo(() => {
    if (activeProvider === "huggingface") {
      return [];
    }

    return PROVIDER_MODEL_PRESETS[activeProvider];
  }, [activeProvider]);

  const selectedModels = useMemo(
    () => sessionModels.filter((model) => model.sourceType === "model"),
    [sessionModels],
  );

  const selectedProviderIds = useMemo(() => {
    const unique = new Set<ProviderId>();
    for (const model of selectedModels) {
      if (isProviderId(model.provider)) {
        unique.add(model.provider);
      }
    }

    return [...unique];
  }, [selectedModels]);

  const selectedProviderModelCounts = useMemo(() => {
    const counts: Record<ProviderId, number> = {
      huggingface: 0,
      openai: 0,
      anthropic: 0,
      google: 0,
    };

    for (const model of selectedModels) {
      if (isProviderId(model.provider)) {
        counts[model.provider] += 1;
      }
    }

    return counts;
  }, [selectedModels]);

  const hasSelectedHfModels = selectedProviderIds.includes("huggingface");

  const selectedModel = useMemo(
    () =>
      sessionModels.find((model) => model.modelId === selectedModelId) ??
      sessionModels[0] ??
      buildInitialBaselineModel(),
    [selectedModelId, sessionModels],
  );

  const selectedModelCode = useMemo(() => {
    return selectedModel.streamedHtml || selectedModel.finalHtml || "";
  }, [selectedModel.finalHtml, selectedModel.streamedHtml]);

  const selectedModelIsGenerating =
    generationLoading &&
    activeGeneratingTaskId === activeTaskId &&
    activeGeneratingModelId === selectedModel.modelId;

  const setTaskSessionModels = useCallback(
    (taskId: TaskId, updater: (previous: SessionModel[]) => SessionModel[]) => {
      setSessionModelsByTask((previous) => ({
        ...previous,
        [taskId]: updater(previous[taskId]),
      }));
    },
    [],
  );

  const setActiveSessionModels = useCallback(
    (updater: (previous: SessionModel[]) => SessionModel[]) => {
      setTaskSessionModels(activeTaskId, updater);
    },
    [activeTaskId, setTaskSessionModels],
  );

  const patchTaskSessionModel = useCallback(
    (taskId: TaskId, modelId: string, updater: (model: SessionModel) => SessionModel) => {
      setTaskSessionModels(taskId, (previous) =>
        previous.map((model) => (model.modelId === modelId ? updater(model) : model)),
      );
    },
    [setTaskSessionModels],
  );

  const setActiveSelectedModelId = useCallback(
    (modelId: string) => {
      setSelectedModelIdByTask((previous) => ({
        ...previous,
        [activeTaskId]: modelId,
      }));
    },
    [activeTaskId],
  );

  const setActiveSkillContent = useCallback(
    (value: string) => {
      setSkillContentByTask((previous) => ({
        ...previous,
        [activeTaskId]: value,
      }));
    },
    [activeTaskId],
  );

  const setActiveProviderPreset = useCallback(
    (value: string | null) => {
      setProviderPresetByTask((previous) => ({
        ...previous,
        [activeTaskId]: value,
      }));
    },
    [activeTaskId],
  );

  const appendTaskModelLog = useCallback(
    (taskId: TaskId, modelId: string, message: string) => {
      const timestamp = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      patchTaskSessionModel(taskId, modelId, (model) => ({
        ...model,
        logs: [...model.logs.slice(-39), `${timestamp} ${message}`],
      }));
    },
    [patchTaskSessionModel],
  );

  const loadOAuthState = useCallback(async (): Promise<OAuthStateSnapshot> => {
    setOauthStatusLoading(true);

    try {
      const [configResponse, sessionResponse] = await Promise.all([
        fetch("/api/auth/hf/config", { cache: "no-store" }),
        fetch("/api/auth/hf/session", { cache: "no-store" }),
      ]);

      let configPayload: OAuthConfigResponse | null = null;
      if (configResponse.ok) {
        configPayload = (await configResponse.json()) as OAuthConfigResponse;
      }
      setOauthConfig(configPayload);

      let sessionConnected = false;
      let sessionExpiresAt: number | null = null;
      if (sessionResponse.ok) {
        const sessionPayload = (await sessionResponse.json()) as OAuthSessionResponse;
        sessionConnected = Boolean(sessionPayload.connected);
        sessionExpiresAt = sessionConnected ? (sessionPayload.expiresAt ?? null) : null;
      }
      setOauthConnected(sessionConnected);
      setOauthExpiresAt(sessionExpiresAt);

      setOauthUiError(null);
      return {
        config: configPayload,
        connected: sessionConnected,
        expiresAt: sessionExpiresAt,
      };
    } catch {
      setOauthConfig(null);
      setOauthConnected(false);
      setOauthExpiresAt(null);
      setOauthUiError("Unable to check Hugging Face OAuth status right now.");
      return {
        config: null,
        connected: false,
        expiresAt: null,
      };
    } finally {
      setOauthStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.has("oauth")) {
        return;
      }
    }

    void loadOAuthState();
  }, [loadOAuthState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    const oauthStatusError = params.get("oauth_error");
    if (!oauthStatus) {
      return;
    }

    autoOAuthAttemptedRef.current = true;
    if (oauthStatus !== "connected") {
      autoOAuthSuppressedRef.current = true;
    }

    params.delete("oauth");
    params.delete("oauth_error");
    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });

    let cancelled = false;

    const syncOAuthStatus = async () => {
      if (oauthStatus === "connected") {
        setGenerationError(null);
        setOauthUiError(null);
        const snapshot = await loadOAuthState();
        if (cancelled) {
          return;
        }

        if (snapshot.connected) {
          setGenerationSuccess("Connected with Hugging Face OAuth.");
        } else {
          setGenerationSuccess(null);
          setOauthUiError(OAUTH_SESSION_NOT_PERSISTED_MESSAGE);
        }
        return;
      }

      if (oauthStatus === "disconnected") {
        setGenerationSuccess("Disconnected from Hugging Face OAuth.");
        setGenerationError(null);
        setOauthUiError(null);
        await loadOAuthState();
        return;
      }

      setGenerationSuccess(null);

      let resolvedOAuthError = "Unable to complete Hugging Face OAuth flow. Try connecting again.";
      if (oauthStatus === "disabled") {
        resolvedOAuthError = OAUTH_UNAVAILABLE_MESSAGE;
      } else if (oauthStatus === "session_secret") {
        resolvedOAuthError = oauthStatusError || OAUTH_SECRET_MISCONFIGURED_MESSAGE;
      } else if (oauthStatus === "missing_pkce") {
        resolvedOAuthError =
          oauthStatusError ||
          "OAuth verifier state was missing. If you opened the embedded Spaces view, open the direct `*.hf.space` URL and try again.";
      } else if (oauthStatus === "exchange_failed") {
        resolvedOAuthError =
          oauthStatusError || "Unable to complete Hugging Face OAuth exchange. Try connecting again.";
      }

      setOauthUiError(resolvedOAuthError);
      await loadOAuthState();
      if (!cancelled) {
        setOauthUiError(resolvedOAuthError);
      }
    };

    void syncOAuthStatus();

    return () => {
      cancelled = true;
    };
  }, [loadOAuthState, pathname, router]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setClientOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setSelectionNotice(null);
  }, [activeTaskId]);

  useEffect(() => {
    const imageReference = getImageToCodeReference(activeImageReferenceId);
    patchTaskSessionModel("image_to_code", BASELINE_MODEL_ID, (model) => ({
      ...model,
      label: `Reference Mockup (${imageReference.label})`,
      finalHtml: buildReferenceHtml(
        "Image to Code Reference",
        imageReference.description,
        imageReference.assetPath,
      ),
      streamedHtml: buildReferenceHtml(
        "Image to Code Reference",
        imageReference.description,
        imageReference.assetPath,
      ),
      error: null,
    }));
  }, [activeImageReferenceId, patchTaskSessionModel]);

  useEffect(() => {
    let active = true;

    const loadBaseline = async () => {
      setBaselineLoadingByTask((previous) => ({
        ...previous,
        html_redesign: true,
      }));
      setBaselineErrorByTask((previous) => ({
        ...previous,
        html_redesign: null,
      }));

      try {
        const response = await fetch(
          `/api/artifacts?modelId=${encodeURIComponent(BASELINE_MODEL_ID)}`,
          {
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error("Unable to load baseline artifact.");
        }

        const payload = (await response.json()) as ArtifactBaselineResponse;
        if (!active) {
          return;
        }

        patchTaskSessionModel("html_redesign", BASELINE_MODEL_ID, (model) => ({
          ...model,
          label: payload.entry.label,
          finalHtml: payload.html,
          streamedHtml: payload.html,
          error: null,
        }));
      } catch {
        if (active) {
          setBaselineErrorByTask((previous) => ({
            ...previous,
            html_redesign: "Unable to load baseline preview.",
          }));
          patchTaskSessionModel("html_redesign", BASELINE_MODEL_ID, (model) => ({
            ...model,
            finalHtml: null,
            streamedHtml: "",
          }));
        }
      } finally {
        if (active) {
          setBaselineLoadingByTask((previous) => ({
            ...previous,
            html_redesign: false,
          }));
        }
      }
    };

    void loadBaseline();

    return () => {
      active = false;
    };
  }, [patchTaskSessionModel]);

  useEffect(() => {
    if (activeProvider !== "huggingface") {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    let active = true;
    const timeoutId = setTimeout(() => {
      void (async () => {
        setSearchLoading(true);
        setSearchError(null);

        try {
          const response = await fetch(
            `/api/hf/models/search?q=${encodeURIComponent(trimmedQuery)}&limit=10`,
            {
              cache: "no-store",
            },
          );

          if (!response.ok) {
            throw new Error("Unable to search Hugging Face models.");
          }

          const payload = (await response.json()) as SearchModelsResponse;
          if (!active) {
            return;
          }

          setSearchResults(payload.models);
        } catch {
          if (active) {
            setSearchError("Unable to search models right now.");
            setSearchResults([]);
          }
        } finally {
          if (active) {
            setSearchLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [activeProvider, searchQuery]);

  const addModelToSelection = useCallback(
    (
      result: SearchModelResult | {
        modelId: string;
        label: string;
        vendor: string;
        providers: string[];
      },
    ) => {
      if (sessionModels.some((model) => model.modelId === result.modelId)) {
        setSelectionNotice(`${result.modelId} is already selected.`);
        return;
      }

      if (selectedModels.length >= MAX_SELECTED_MODELS) {
        setSelectionNotice(`You can compare up to ${MAX_SELECTED_MODELS} models at once.`);
        return;
      }

      setActiveSessionModels((previous) => [
        ...previous,
        {
          modelId: result.modelId,
          label: result.label,
          vendor: result.vendor,
          provider: activeProvider,
          sourceType: "model",
          providers: result.providers,
          status: "queued",
          streamedHtml: "",
          finalHtml: null,
          logs: [],
          attempts: [],
          error: null,
        },
      ]);
      setSelectionNotice(null);
      setSearchQuery("");
      setSearchResults([]);
      setActiveProviderPreset(null);
    },
    [
      activeProvider,
      selectedModels.length,
      sessionModels,
      setActiveProviderPreset,
      setActiveSessionModels,
    ],
  );

  const handleProviderChange = useCallback(
    (provider: ProviderId) => {
      if (generationLoading) {
        return;
      }

      setActiveProviderByTask((previous) => ({
        ...previous,
        [activeTaskId]: provider,
      }));
      setActiveProviderPreset(null);
      setSearchQuery("");
      setSearchResults([]);
      setSearchError(null);
      setSelectionNotice(null);
    },
    [
      activeTaskId,
      generationLoading,
      setActiveProviderPreset,
    ],
  );

  const removeSelectedModel = useCallback(
    (modelId: string) => {
      if (generationLoading) {
        return;
      }

      setActiveSessionModels((previous) =>
        previous.filter((model) => model.modelId !== modelId),
      );
      if (selectedModelId === modelId) {
        setActiveSelectedModelId(BASELINE_MODEL_ID);
      }
      setSelectionNotice(null);
    },
    [generationLoading, selectedModelId, setActiveSelectedModelId, setActiveSessionModels],
  );

  const openSkillModal = useCallback(() => {
    setSkillDraft(skillContent);
    setSkillError(null);
    setIsSkillModalOpen(true);
  }, [skillContent]);

  const closeSkillModal = useCallback(() => {
    setIsSkillModalOpen(false);
    setSkillError(null);
    setSkillDraft(skillContent);
  }, [skillContent]);

  const handleSaveSkill = useCallback(() => {
    const normalizedSkill = skillDraft.trim();
    if (normalizedSkill.length > MAX_SKILL_CONTENT_CHARS) {
      setSkillError(SKILL_TOO_LONG_MESSAGE);
      return;
    }

    setActiveSkillContent(normalizedSkill);
    setSkillError(null);
    setIsSkillModalOpen(false);
  }, [setActiveSkillContent, skillDraft]);

  const handleClearSkill = useCallback(() => {
    setSkillDraft("");
    setActiveSkillContent("");
    setSkillError(null);
  }, [setActiveSkillContent]);

  const handleOAuthConnect = useCallback(async () => {
    if (!oauthConfig?.enabled || !oauthConfig.clientId) {
      setOauthUiError(OAUTH_UNAVAILABLE_MESSAGE);
      return;
    }

    setGenerationError(null);
    setOauthUiError(null);
    setOauthActionLoading(true);

    try {
      const loginUrl = "/api/auth/hf/start";
      setOauthActionLoading(false);
      window.location.assign(loginUrl);
      return;
    } catch (error) {
      console.error("[evaluator-client] oauth_connect_failed", error);
      setOauthUiError(getOAuthConnectErrorMessage(error));
    }

    setOauthActionLoading(false);
  }, [oauthConfig]);

  useEffect(() => {
    if (oauthStatusLoading || oauthActionLoading || oauthConnected) {
      return;
    }

    if (!oauthConfig?.enabled || !oauthConfig.clientId) {
      return;
    }

    if (oauthConfig.mode !== "space") {
      return;
    }

    if (autoOAuthAttemptedRef.current || autoOAuthSuppressedRef.current) {
      return;
    }

    autoOAuthAttemptedRef.current = true;
    void handleOAuthConnect();
  }, [
    handleOAuthConnect,
    oauthActionLoading,
    oauthConfig,
    oauthConnected,
    oauthStatusLoading,
  ]);

  const handleOAuthDisconnect = useCallback(async () => {
    autoOAuthSuppressedRef.current = true;
    setOauthActionLoading(true);
    setGenerationError(null);
    setOauthUiError(null);

    try {
      const response = await fetch("/api/auth/hf/session", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Unable to disconnect Hugging Face OAuth.");
      }

      setGenerationSuccess("Disconnected from Hugging Face OAuth.");
      setOauthConnected(false);
      setOauthExpiresAt(null);
      await loadOAuthState();
    } catch {
      setOauthUiError("Unable to disconnect Hugging Face OAuth.");
    } finally {
      setOauthActionLoading(false);
    }
  }, [loadOAuthState]);

  const runGeneration = useCallback(async () => {
    setGenerationError(null);
    setGenerationSuccess(null);
    setActiveCodeFile("index.html");

    const hfKey = hfApiKey.trim();
    const openaiKey = openaiApiKey.trim();
    const anthropicKey = anthropicApiKey.trim();
    const googleKey = googleApiKey.trim();
    const billTo = generationBillTo.trim();
    const normalizedSkill = skillContent.trim();
    const generationTaskId = activeTaskId;
    const generationTaskContext = activeTaskContext;

    if (!selectedModels.length) {
      setGenerationError("Select at least one model to generate.");
      return;
    }

    const providerIdsFromSelection: ProviderId[] = [];
    const providerSet = new Set<ProviderId>();
    for (const model of selectedModels) {
      if (isProviderId(model.provider)) {
        providerSet.add(model.provider);
      }
    }
    providerIdsFromSelection.push(...providerSet);

    if (providerIdsFromSelection.includes("openai") && !openaiKey) {
      setGenerationError(PROVIDER_KEY_REQUIRED_MESSAGE.openai);
      return;
    }

    if (providerIdsFromSelection.includes("anthropic") && !anthropicKey) {
      setGenerationError(PROVIDER_KEY_REQUIRED_MESSAGE.anthropic);
      return;
    }

    if (providerIdsFromSelection.includes("google") && !googleKey) {
      setGenerationError(PROVIDER_KEY_REQUIRED_MESSAGE.google);
      return;
    }

    if (providerIdsFromSelection.includes("huggingface") && !hfKey) {
      const oauthSnapshot = await loadOAuthState();
      const oauthIsAvailable = Boolean(
        oauthSnapshot.config?.enabled && oauthSnapshot.config.clientId,
      );
      if (!oauthSnapshot.connected) {
        setGenerationError(
          oauthIsAvailable
            ? "Add your Hugging Face API key or connect with Hugging Face OAuth to run generation."
            : "Add your Hugging Face API key to run generation.",
        );
        return;
      }
    }

    if (normalizedSkill.length > MAX_SKILL_CONTENT_CHARS) {
      setGenerationError(SKILL_TOO_LONG_MESSAGE);
      return;
    }

    setActiveSessionModels((previous) =>
      previous.map((model) =>
        model.sourceType === "model"
          ? {
              ...model,
              status: "queued",
              streamedHtml: "",
              finalHtml: null,
              logs: [],
              attempts: [],
              error: null,
            }
          : model,
      ),
    );

    setIsGenerateModalOpen(false);
    setGenerationLoading(true);
    setActiveGeneratingTaskId(generationTaskId);

    let failedCount = 0;

    try {
      for (const [index, model] of selectedModels.entries()) {
        if (!isProviderId(model.provider)) {
          continue;
        }

        const modelProvider = model.provider;
        const queuePosition = `${index + 1}/${selectedModels.length}`;
        setGenerationStatus(
          `Generating ${model.label} (${getProviderLabel(modelProvider)} • ${queuePosition})...`,
        );
        setActiveGeneratingModelId(model.modelId);
        setActiveSelectedModelId(model.modelId);
        setActiveMainTab("code");

        patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
          ...current,
          status: "generating",
          streamedHtml: "",
          finalHtml: null,
          logs: [],
          attempts: [],
          error: null,
        }));
        appendTaskModelLog(generationTaskId, model.modelId, `Started generation (${queuePosition}).`);

        try {
          const body: {
            provider: ProviderId;
            hfApiKey?: string;
            openaiApiKey?: string;
            anthropicApiKey?: string;
            googleApiKey?: string;
            modelId: string;
            providerCandidates?: string[];
            billTo?: string;
            skillContent?: string;
            taskId: TaskId;
            taskContext: TaskContext;
          } = {
            provider: modelProvider,
            modelId: model.modelId,
            taskId: generationTaskId,
            taskContext: generationTaskContext,
          };

          if (modelProvider === "huggingface" && hfKey) {
            body.hfApiKey = hfKey;
          }

          if (modelProvider === "openai" && openaiKey) {
            body.openaiApiKey = openaiKey;
          }

          if (modelProvider === "anthropic" && anthropicKey) {
            body.anthropicApiKey = anthropicKey;
          }

          if (modelProvider === "google" && googleKey) {
            body.googleApiKey = googleKey;
          }

          if (modelProvider === "huggingface") {
            const providers = normalizeProviderCandidates(model.providers);
            if (providers.length > 0) {
              body.providerCandidates = providers;
            }
          }

          if (modelProvider === "huggingface" && billTo) {
            body.billTo = billTo;
          }

          if (normalizedSkill) {
            body.skillContent = normalizedSkill;
          }

          const response = await fetch("/api/generate/stream", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const payload = isJsonResponse(response)
              ? ((await response.json()) as {
                  error?: string;
                  attempts?: GenerationAttempt[];
                })
              : null;

            if (payload?.attempts?.length) {
              patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
                ...current,
                attempts: payload.attempts ?? [],
              }));
              payload.attempts.forEach((attempt, attemptIndex) => {
                appendTaskModelLog(
                  generationTaskId,
                  model.modelId,
                  formatAttemptLogLine(
                    attempt,
                    attemptIndex,
                    payload.attempts?.length ?? 0,
                  ),
                );
              });
            }

            throw new Error(payload?.error ?? getGenerationStatusMessage(response.status));
          }

          if (!response.body) {
            throw new Error("Streaming response body is not available.");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let done = false;
          let buffer = "";
          let completed = false;

          while (!done) {
            const result = await reader.read();
            done = result.done;
            buffer += decoder.decode(result.value ?? new Uint8Array(), {
              stream: !done,
            });

            let separatorIndex = buffer.indexOf("\n\n");
            while (separatorIndex >= 0) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              separatorIndex = buffer.indexOf("\n\n");

              const parsedBlock = parseSseEventBlock(block);
              if (!parsedBlock) {
                continue;
              }

              if (parsedBlock.event === "meta") {
                const payload = parsedBlock.payload as HfGenerationStreamMetaPayload;
                appendTaskModelLog(
                  generationTaskId,
                  model.modelId,
                  `Stream ready with ${payload.plannedAttempts} planned attempts.`,
                );
                continue;
              }

              if (parsedBlock.event === "attempt") {
                const payload = parsedBlock.payload as HfGenerationStreamAttemptPayload;
                if (payload.resetCode) {
                  patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
                    ...current,
                    streamedHtml: "",
                  }));
                }

                appendTaskModelLog(
                  generationTaskId,
                  model.modelId,
                  `Attempt ${payload.attemptNumber}/${payload.totalAttempts} started (${payload.model}).`,
                );
                continue;
              }

              if (parsedBlock.event === "token") {
                const payload = parsedBlock.payload as HfGenerationStreamTokenPayload;
                if (!payload.text) {
                  continue;
                }

                patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
                  ...current,
                  streamedHtml: current.streamedHtml + payload.text,
                }));
                continue;
              }

              if (parsedBlock.event === "log") {
                const payload = parsedBlock.payload as HfGenerationStreamLogPayload;
                if (payload.message) {
                  appendTaskModelLog(generationTaskId, model.modelId, payload.message);
                }
                continue;
              }

              if (parsedBlock.event === "complete") {
                const payload = parsedBlock.payload as HfGenerationStreamCompletePayload;
                completed = true;

                patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
                  ...current,
                  status: "done",
                  finalHtml: payload.result.html,
                  streamedHtml: payload.result.html,
                  attempts: payload.generation.attempts,
                  error: null,
                }));

                payload.generation.attempts.forEach((attempt, attemptIndex) => {
                  appendTaskModelLog(
                    generationTaskId,
                    model.modelId,
                    formatAttemptLogLine(
                      attempt,
                      attemptIndex,
                      payload.generation.attempts.length,
                    ),
                  );
                });

                appendTaskModelLog(
                  generationTaskId,
                  model.modelId,
                  "Generation complete for this session.",
                );
                setActiveMainTab("app");
                continue;
              }

              if (parsedBlock.event === "error") {
                const payload = parsedBlock.payload as HfGenerationStreamErrorPayload;
                patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
                  ...current,
                  attempts: payload.attempts ?? current.attempts,
                }));

                if (payload.attempts?.length) {
                  payload.attempts.forEach((attempt, attemptIndex) => {
                    appendTaskModelLog(
                      generationTaskId,
                      model.modelId,
                      formatAttemptLogLine(
                        attempt,
                        attemptIndex,
                        payload.attempts?.length ?? 0,
                      ),
                    );
                  });
                }

                throw new Error(payload.message || "Generation failed.");
              }
            }
          }

          if (!completed) {
            throw new Error("Generation stream ended before completion.");
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Unable to generate this model in the current session.";

          failedCount += 1;
          patchTaskSessionModel(generationTaskId, model.modelId, (current) => ({
            ...current,
            status: "error",
            error: message,
            finalHtml: null,
          }));
          appendTaskModelLog(generationTaskId, model.modelId, `Generation failed: ${message}`);
          setActiveMainTab("app");
        }
      }

      if (failedCount > 0) {
        setGenerationError(
          `${failedCount} of ${selectedModels.length} model generations failed. Completed outputs are available for the rest.`,
        );
      } else {
        setGenerationSuccess(
          `Generated ${selectedModels.length} model output${selectedModels.length > 1 ? "s" : ""} in this session only.`,
        );
      }
    } finally {
      setGenerationLoading(false);
      setActiveGeneratingTaskId(null);
      setActiveGeneratingModelId(null);
      setGenerationStatus(null);
    }
  }, [
    activeTaskContext,
    activeTaskId,
    appendTaskModelLog,
    anthropicApiKey,
    generationBillTo,
    googleApiKey,
    hfApiKey,
    loadOAuthState,
    openaiApiKey,
    patchTaskSessionModel,
    setActiveSelectedModelId,
    setActiveSessionModels,
    skillContent,
    selectedModels,
  ]);

  const handleGenerateSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await runGeneration();
    },
    [runGeneration],
  );

  const handleGenerateAction = useCallback(async () => {
    setGenerationError(null);

    if (generationLoading) {
      return;
    }

    if (!selectedModels.length) {
      setGenerationError("Select at least one model to generate.");
      return;
    }

    const hasHuggingFaceModels = selectedProviderIds.includes("huggingface");
    const hasNonHuggingFaceModels = selectedProviderIds.some(
      (provider) => provider !== "huggingface",
    );

    if (!hasHuggingFaceModels || hasNonHuggingFaceModels) {
      setIsGenerateModalOpen(true);
      return;
    }

    if (oauthStatusLoading) {
      const snapshot = await loadOAuthState();
      if (snapshot.connected) {
        await runGeneration();
        return;
      }

      setIsGenerateModalOpen(true);
      return;
    }

    if (oauthConnected) {
      await runGeneration();
      return;
    }

    setIsGenerateModalOpen(true);
  }, [
    generationLoading,
    loadOAuthState,
    oauthConnected,
    oauthStatusLoading,
    runGeneration,
    selectedProviderIds,
    selectedModels.length,
  ]);

  const handleSearchInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (activeProvider !== "huggingface") {
        return;
      }

      if (event.key !== "Enter") {
        return;
      }

      if (searchResults.length === 0) {
        return;
      }

      event.preventDefault();
      addModelToSelection(searchResults[0]);
    },
    [activeProvider, addModelToSelection, searchResults],
  );

  const previewHtml = selectedModel.finalHtml;

  const previewErrorMessage = useMemo(() => {
    if (selectedModel.sourceType === "baseline") {
      return baselineError;
    }

    if (selectedModel.error) {
      return selectedModel.error;
    }

    if (!selectedModel.finalHtml) {
      if (selectedModel.status === "generating") {
        return "Generation in progress for this model.";
      }

      return "No generated output yet for this model.";
    }

    return null;
  }, [baselineError, selectedModel]);

  const canOpenGenerateModal = selectedModels.length > 0;
  const oauthAvailable = Boolean(oauthConfig?.enabled && oauthConfig.clientId);
  const showOAuthControls =
    (activeProvider === "huggingface" || hasSelectedHfModels) &&
    (oauthStatusLoading || oauthAvailable);
  const selectedProviderLabels = selectedProviderIds.map((provider) => getProviderLabel(provider));
  const getApiKeyPlaceholder = (provider: ProviderId): string => {
    if (provider === "huggingface") {
      return "hf_...";
    }

    if (provider === "openai") {
      return "sk-...";
    }

    if (provider === "anthropic") {
      return "sk-ant-...";
    }

    return "AIza...";
  };
  const getApiKeyValue = (provider: ProviderId): string => {
    if (provider === "huggingface") {
      return hfApiKey;
    }

    if (provider === "openai") {
      return openaiApiKey;
    }

    if (provider === "anthropic") {
      return anthropicApiKey;
    }

    return googleApiKey;
  };
  const setApiKeyValue = (provider: ProviderId, value: string): void => {
    if (provider === "huggingface") {
      setHfApiKey(value);
      return;
    }

    if (provider === "openai") {
      setOpenaiApiKey(value);
      return;
    }

    if (provider === "anthropic") {
      setAnthropicApiKey(value);
      return;
    }

    setGoogleApiKey(value);
  };
  const selectedProviderPresetModel =
    activeProvider === "huggingface"
      ? null
      : activeProviderPresets.find((preset) => preset.modelId === providerPreset) ?? null;

  return (
    <>
      <div className="grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-border bg-sidebar p-4 lg:border-r lg:border-b-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="inline-flex items-center gap-1.5">
                <div className="size-2.5 rounded-full bg-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Frontend Evals
                </span>
              </div>
              <h1 className="mt-1.5 text-lg leading-tight font-semibold">
                Model Comparison
              </h1>
            </div>
            <ThemeToggle />
          </div>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <CardTitle className="text-sm">Tasks</CardTitle>
              <CardDescription className="text-xs">
                Choose a benchmark task. Model picks, skills, and outputs are kept per task.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 px-3">
              <div className="space-y-2">
                {TASK_OPTIONS.map((task) => {
                  const isActive = task.id === activeTaskId;
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        if (!generationLoading) {
                          setActiveTaskId(task.id);
                        }
                      }}
                      disabled={generationLoading}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        isActive
                          ? "border-primary bg-primary/5"
                          : "border-border bg-background hover:bg-muted/70"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <p className="text-sm font-medium">{task.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
                    </button>
                  );
                })}
              </div>

              {activeTaskId === "image_to_code" ? (
                <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
                  <label htmlFor="image-reference-select" className="text-xs font-medium text-foreground">
                    Mockup Reference
                  </label>
                  <select
                    id="image-reference-select"
                    aria-label="Image-to-Code reference"
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                    value={activeImageReferenceId}
                    disabled={generationLoading}
                    onChange={(event) =>
                      setActiveImageReferenceId(event.target.value as ImageToCodeReference["id"])
                    }
                  >
                    {IMAGE_TO_CODE_REFERENCES.map((reference) => (
                      <option key={reference.id} value={reference.id}>
                        {reference.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    {selectedImageReference.description}
                  </p>
                </div>
              ) : null}

              {activeTaskId === "multistep_form" ? (
                <p className="rounded-lg border border-border bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
                  Variant: SaaS onboarding (Account, Company, Team Invite, Plan/Billing, Review).
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Models & Provider</CardTitle>
                <Badge variant="outline">Max {MAX_SELECTED_MODELS}</Badge>
              </div>
              <CardDescription className="text-xs">
                Choose a provider, then add up to {MAX_SELECTED_MODELS} models for this task.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-3">
              <div className="space-y-1">
                <label htmlFor="provider-select" className="text-xs font-medium text-muted-foreground">
                  Provider
                </label>
                <select
                  id="provider-select"
                  aria-label="Generation provider"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                  value={activeProvider}
                  disabled={generationLoading}
                  onChange={(event) => {
                    if (isProviderId(event.target.value)) {
                      handleProviderChange(event.target.value);
                    }
                  }}
                >
                  {PROVIDER_OPTIONS.map((providerOption) => (
                    <option key={providerOption.id} value={providerOption.id}>
                      {providerOption.label}
                    </option>
                  ))}
                </select>
              </div>

              {activeProvider === "huggingface" ? (
                <>
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleSearchInputKeyDown}
                    placeholder="Search models on HF..."
                    aria-label="Search Hugging Face models"
                    disabled={generationLoading}
                  />

                  {searchLoading ? (
                    <p className="text-xs text-muted-foreground">Searching models...</p>
                  ) : null}

                  {searchError ? <p className="text-xs text-destructive">{searchError}</p> : null}

                  {!searchLoading && searchQuery.trim().length >= 2 ? (
                    searchResults.length > 0 ? (
                      <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                        {searchResults.map((result) => (
                          <button
                            key={result.modelId}
                            type="button"
                            onClick={() => addModelToSelection(result)}
                            disabled={generationLoading}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <p className="truncate text-sm font-medium">{result.label}</p>
                            <p className="truncate text-xs text-muted-foreground">{result.modelId}</p>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No matching inference-provider models found.
                      </p>
                    )
                  ) : null}
                </>
              ) : (
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
                  <label
                    htmlFor="provider-model-preset-select"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {getProviderLabel(activeProvider)} model presets
                  </label>
                  <select
                    id="provider-model-preset-select"
                    aria-label={`${getProviderLabel(activeProvider)} model presets`}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                    value={providerPreset ?? ""}
                    disabled={generationLoading}
                    onChange={(event) =>
                      setActiveProviderPreset(event.target.value || null)
                    }
                  >
                    <option value="">Select a model preset</option>
                    {activeProviderPresets.map((preset) => (
                      <option key={preset.modelId} value={preset.modelId}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={generationLoading || !selectedProviderPresetModel}
                    onClick={() => {
                      if (!selectedProviderPresetModel) {
                        return;
                      }

                      addModelToSelection({
                        modelId: selectedProviderPresetModel.modelId,
                        label: selectedProviderPresetModel.label,
                        vendor: selectedProviderPresetModel.vendor,
                        providers: [],
                      });
                    }}
                  >
                    Add Preset Model
                  </Button>
                </div>
              )}

              {selectionNotice ? (
                <p className="text-xs text-muted-foreground">{selectionNotice}</p>
              ) : null}

              <div className="space-y-2 rounded-lg border border-dashed border-border p-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Selected Models
                </p>
                {selectedModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No models selected yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {selectedModels.map((model) => (
                      <li key={model.modelId} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs text-foreground">{model.modelId}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {isProviderId(model.provider) ? getProviderLabel(model.provider) : "Unknown"}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={generationLoading}
                          onClick={() => removeSelectedModel(model.modelId)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={generationLoading}
                  onClick={openSkillModal}
                >
                  {skillContent ? "Edit Skill" : "Add Skill"}
                </Button>
                <Button
                  type="button"
                  variant="accent"
                  disabled={!canOpenGenerateModal || generationLoading}
                  onClick={() => {
                    void handleGenerateAction();
                  }}
                >
                  Generate Selected
                </Button>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Generated outputs are kept in memory for this browser session only.
              </p>

              {skillContent ? (
                <p className="text-[11px] text-muted-foreground">
                  Skill attached • {skillContent.length} chars
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No skill attached.
                </p>
              )}

              {generationSuccess ? (
                <p className="text-xs text-green-600 dark:text-green-400">{generationSuccess}</p>
              ) : null}
              {generationError && !isGenerateModalOpen ? (
                <p className="text-xs text-destructive">{generationError}</p>
              ) : null}
            </CardContent>
          </Card>

          {showOAuthControls ? (
            <Card className="gap-3 py-3">
              <CardHeader className="px-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">Hugging Face Auth</CardTitle>
                  <Badge
                    variant={oauthStatusLoading ? "outline" : oauthConnected ? "default" : "outline"}
                  >
                    {oauthStatusLoading ? "checking" : oauthConnected ? "connected" : "not connected"}
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  Connect once to generate without manually pasting a key every time.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 px-3">
                {oauthStatusLoading ? (
                  <p className="text-xs text-muted-foreground">Checking OAuth session...</p>
                ) : oauthConnected ? (
                  <>
                    <p className="text-xs text-muted-foreground">{formatOAuthExpiry(oauthExpiresAt)}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={handleOAuthDisconnect}
                      disabled={oauthActionLoading || generationLoading}
                    >
                      {oauthActionLoading ? "Disconnecting..." : "Disconnect Hugging Face"}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={handleOAuthConnect}
                    disabled={oauthActionLoading || generationLoading}
                  >
                    {oauthActionLoading ? "Opening OAuth..." : "Connect with Hugging Face"}
                  </Button>
                )}

                {oauthUiError ? <p className="text-xs text-destructive">{oauthUiError}</p> : null}
              </CardContent>
            </Card>
          ) : null}

          <Card className="gap-3 py-3">
            <CardHeader className="px-3">
              <CardTitle className="text-sm">Session Models</CardTitle>
              <CardDescription className="text-xs">
                Task reference plus selected models to compare.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 px-3">
              {sessionModels.map((model) => {
                const isActive = model.modelId === selectedModelId;
                return (
                  <button
                    key={model.modelId}
                    type="button"
                    onClick={() => setActiveSelectedModelId(model.modelId)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:bg-muted/70"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{model.label}</p>
                      {getStatusBadge(model.status)}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{model.modelId}</p>
                    {model.sourceType === "model" && isProviderId(model.provider) ? (
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {getProviderLabel(model.provider)}
                      </p>
                    ) : null}
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <PromptCard prompt={activePrompt} promptVersion={activeTaskDefinition.promptVersion} />
        </aside>

        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
            <div className="border-b border-border px-4 py-2">
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setActiveMainTab("code")}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    activeMainTab === "code"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Code
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMainTab("app")}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    activeMainTab === "app"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {activeMainTab === "code" ? (
                <CodeStreamPanel
                  streamedHtml={selectedModelCode}
                  activeFile={activeCodeFile}
                  onActiveFileChange={setActiveCodeFile}
                  generationLoading={selectedModelIsGenerating}
                  generationStatus={selectedModelIsGenerating ? generationStatus : null}
                  generationLogs={selectedModel.logs}
                  generationError={selectedModel.error}
                />
              ) : (
                <PreviewFrame
                  html={previewHtml}
                  title={`${selectedModel.label} output`}
                  loading={selectedModel.modelId === BASELINE_MODEL_ID && baselineLoading}
                  errorMessage={previewErrorMessage}
                  generationLoading={selectedModelIsGenerating}
                  generationStatus={selectedModelIsGenerating ? generationStatus : null}
                />
              )}
            </div>
          </div>
        </section>
      </div>

      {isSkillModalOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-modal-title"
          onClick={closeSkillModal}
        >
          <Card
            className="w-full max-w-2xl gap-3 py-3"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="px-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle id="skill-modal-title" className="text-base">
                    Add Skill Context
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Paste custom design skill instructions. This skill applies to all models in this generation batch.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={closeSkillModal}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="skill-content"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Skill Content
                </label>
                <textarea
                  id="skill-content"
                  value={skillDraft}
                  onChange={(event) => {
                    setSkillDraft(event.target.value);
                    if (skillError) {
                      setSkillError(null);
                    }
                  }}
                  placeholder="Paste your frontend design skill content here..."
                  className="h-52 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring"
                />
                <p className="text-[11px] text-muted-foreground">
                  {skillDraft.trim().length}/{MAX_SKILL_CONTENT_CHARS} characters
                </p>
              </div>

              {skillError ? (
                <p className="text-xs text-destructive">{skillError}</p>
              ) : null}

              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="accent"
                  onClick={handleSaveSkill}
                >
                  Save Skill
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClearSkill}
                >
                  Clear Skill
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeSkillModal}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {isGenerateModalOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="generate-model-title"
          onClick={() => {
            if (!generationLoading) {
              setIsGenerateModalOpen(false);
            }
          }}
        >
          <Card
            className="w-full max-w-xl gap-3 py-3"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="px-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle id="generate-model-title" className="text-base">
                    Generate Session Outputs
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {selectedProviderLabels.length > 1
                      ? `Generate selected models across ${selectedProviderLabels.join(", ")} in sequence.`
                      : `Generate all selected ${getProviderLabel(selectedProviderIds[0] ?? activeProvider)} models in sequence.`}{" "}
                    Outputs are stored only in memory for this session.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsGenerateModalOpen(false)}
                  disabled={generationLoading}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-4">
              <form className="space-y-2.5" onSubmit={handleGenerateSubmit}>
                {showOAuthControls && selectedProviderIds.includes("huggingface") ? (
                  <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-foreground">Hugging Face OAuth</p>
                      <Badge variant={oauthConnected ? "default" : "outline"}>
                        {oauthConnected ? "connected" : "not connected"}
                      </Badge>
                    </div>

                    {oauthStatusLoading ? (
                      <p className="text-xs text-muted-foreground">Checking OAuth session...</p>
                    ) : oauthConnected ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {formatOAuthExpiry(oauthExpiresAt)}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={handleOAuthDisconnect}
                          disabled={oauthActionLoading || generationLoading}
                        >
                          {oauthActionLoading ? "Disconnecting..." : "Disconnect Hugging Face"}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={handleOAuthConnect}
                        disabled={oauthActionLoading || generationLoading}
                      >
                        {oauthActionLoading ? "Opening OAuth..." : "Connect with Hugging Face"}
                      </Button>
                    )}

                    {oauthUiError ? (
                      <p className="text-xs text-destructive">{oauthUiError}</p>
                    ) : null}
                  </div>
                ) : null}

                {(selectedProviderIds.length > 0 ? selectedProviderIds : [activeProvider]).map(
                  (provider) => {
                    const apiKeyValue = getApiKeyValue(provider);
                    const isHuggingFace = provider === "huggingface";

                    return (
                      <div key={`api-key-${provider}`} className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">
                          {getProviderLabel(provider)} API Key
                          <span className="ml-1 text-muted-foreground/50">
                            {isHuggingFace && oauthAvailable
                              ? "optional when OAuth is connected"
                              : "required"}
                          </span>
                        </label>
                        <p className="text-[11px] text-muted-foreground/70">
                          Used for {selectedProviderModelCounts[provider]} selected model
                          {selectedProviderModelCounts[provider] === 1 ? "" : "s"}.
                        </p>
                        <div className="flex items-center gap-2">
                          <Input
                            type="password"
                            value={apiKeyValue}
                            onChange={(event) => setApiKeyValue(provider, event.target.value)}
                            placeholder={getApiKeyPlaceholder(provider)}
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setApiKeyValue(provider, "")}
                            disabled={generationLoading || apiKeyValue.length === 0}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                    );
                  },
                )}

                {selectedProviderIds.includes("huggingface") ? (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      Bill To
                      <span className="ml-1 text-muted-foreground/50">optional</span>
                    </label>
                    <Input
                      value={generationBillTo}
                      onChange={(event) => setGenerationBillTo(event.target.value)}
                      placeholder="huggingface"
                      autoComplete="off"
                    />
                    <p className="text-[11px] leading-tight text-muted-foreground/70">
                      Sends <code>X-HF-Bill-To</code> when provided.
                    </p>
                  </div>
                ) : null}

                <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  Generating {selectedModels.length} selected model
                  {selectedModels.length === 1 ? "" : "s"} across{" "}
                  {selectedProviderLabels.length > 0
                    ? selectedProviderLabels.join(", ")
                    : getProviderLabel(activeProvider)}
                  .
                </div>

                <Button className="w-full" variant="accent" type="submit" disabled={generationLoading}>
                  {generationLoading ? "Generating..." : "Generate Selected Models"}
                </Button>

                {generationError ? (
                  <p className="text-xs text-destructive">{generationError}</p>
                ) : null}
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
