export class HFGenerationError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HFGenerationError";
    this.status = status;
  }
}

interface GenerateWithHfInput {
  hfApiKey: string;
  modelId: string;
  prompt: string;
  baselineHtml: string;
}

interface HfChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

const SYSTEM_PROMPT =
  "You are an expert frontend engineer. Return only one complete HTML document with embedded CSS and JS. No markdown fences, no explanations.";

function coerceMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item === "object" && item !== null) {
          const maybeText = (item as { text?: unknown }).text;
          if (typeof maybeText === "string") {
            return maybeText;
          }
        }

        return "";
      })
      .join("\n");
  }

  return "";
}

export function extractHtmlDocument(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new HFGenerationError("Model returned empty output.", 422);
  }

  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;

  const lowerCandidate = candidate.toLowerCase();
  const doctypeIndex = lowerCandidate.indexOf("<!doctype html");
  const htmlIndex = lowerCandidate.indexOf("<html");

  if (doctypeIndex >= 0) {
    const endIndex = lowerCandidate.lastIndexOf("</html>");
    if (endIndex >= 0) {
      return candidate.slice(doctypeIndex, endIndex + "</html>".length).trim();
    }

    return candidate.slice(doctypeIndex).trim();
  }

  if (htmlIndex >= 0) {
    const endIndex = lowerCandidate.lastIndexOf("</html>");
    if (endIndex >= 0) {
      return candidate.slice(htmlIndex, endIndex + "</html>".length).trim();
    }

    return candidate.slice(htmlIndex).trim();
  }

  throw new HFGenerationError("Model output does not contain a full HTML document.", 422);
}

function buildUserPrompt(prompt: string, baselineHtml: string): string {
  return [
    prompt,
    "",
    "Use this baseline HTML as input context:",
    "```html",
    baselineHtml,
    "```",
  ].join("\n");
}

export async function generateHtmlWithHuggingFace({
  hfApiKey,
  modelId,
  prompt,
  baselineHtml,
}: GenerateWithHfInput): Promise<string> {
  const timeoutMs = Number.parseInt(process.env.GENERATION_TIMEOUT_MS ?? "60000", 10);
  const baseUrl = process.env.HF_BASE_URL ?? "https://router.huggingface.co/v1/chat/completions";

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        max_tokens: 8192,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserPrompt(prompt, baselineHtml),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new HFGenerationError("Invalid Hugging Face API key.", response.status);
      }

      if (response.status === 404) {
        throw new HFGenerationError("Model ID not found on Hugging Face providers.", 404);
      }

      throw new HFGenerationError(
        `Hugging Face generation failed (${response.status}): ${errorText.slice(0, 240)}`,
        502,
      );
    }

    const payload = (await response.json()) as HfChatResponse;
    const content = coerceMessageContent(payload.choices?.[0]?.message?.content);

    return extractHtmlDocument(content);
  } catch (error) {
    if (error instanceof HFGenerationError) {
      throw error;
    }

    if ((error as Error).name === "AbortError") {
      throw new HFGenerationError("Hugging Face generation timed out.", 504);
    }

    throw new HFGenerationError("Unable to contact Hugging Face providers.", 502);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
