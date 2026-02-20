// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { listModelsMock } = vi.hoisted(() => ({
  listModelsMock: vi.fn(),
}));

vi.mock("@huggingface/hub", () => ({
  listModels: (...args: unknown[]) => listModelsMock(...args),
}));

import { GET } from "@/app/api/hf/models/search/route";

function asAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  return (async function* iterator() {
    for (const item of items) {
      yield item;
    }
  })();
}

describe("GET /api/hf/models/search", () => {
  beforeEach(() => {
    listModelsMock.mockReset();
  });

  it("returns empty models for short queries", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/hf/models/search?q=a", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ models: [] });
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("returns normalized inference-provider model results with sanitized limit", async () => {
    listModelsMock.mockReturnValue(
      asAsyncGenerator([
        {
          name: "moonshotai/Kimi-K2.5",
          inferenceProviderMapping: [
            { provider: "together" },
            { provider: "novita" },
            { provider: "novita" },
          ],
        },
        {
          name: "some/without-providers",
          inferenceProviderMapping: [],
        },
        {
          name: "minimax/MiniMax-M1",
          inferenceProviderMapping: [{ provider: "hf-inference" }],
        },
      ]),
    );

    const response = await GET(
      new NextRequest("http://localhost/api/hf/models/search?q=kimi&limit=999", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [
        {
          modelId: "moonshotai/Kimi-K2.5",
          label: "Kimi-K2.5",
          vendor: "moonshotai",
          providers: ["together", "novita"],
        },
        {
          modelId: "minimax/MiniMax-M1",
          label: "MiniMax-M1",
          vendor: "minimax",
          providers: ["hf-inference"],
        },
      ],
    });

    expect(listModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { query: "kimi" },
        additionalFields: ["inferenceProviderMapping"],
        limit: 60,
        sort: "downloads",
      }),
    );
  });
});
