import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenRouterClient,
  OpenRouterError,
  type ChatTool,
} from "../src/ai/openrouter.js";

afterEach(() => vi.unstubAllGlobals());

function client(overrides: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {}) {
  return new OpenRouterClient({
    apiKey: "secret-key",
    model: "test/model",
    baseUrl: "https://router.test/api/v1/",
    timeoutMs: 1_000,
    maxTokens: 321,
    ...overrides,
  });
}

describe("OpenRouterClient", () => {
  it("posts an OpenAI-compatible low-temperature request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().complete({ messages: [{ role: "user", content: "Hi" }] });

    expect(result).toEqual({
      message: { role: "assistant", content: "Hello" },
      finishReason: "stop",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toBe("https://router.test/api/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "test/model",
      max_tokens: 321,
      temperature: 0.1,
      provider: {
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    });
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  it("parses tool calls and serializes assistant/tool follow-up messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "players", arguments: "{\"online\":true}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Three online" }, finish_reason: "stop" }],
      })));
    vi.stubGlobal("fetch", fetchMock);
    const tool: ChatTool = {
      type: "function",
      function: {
        name: "players",
        description: "List players",
        parameters: { type: "object", properties: { online: { type: "boolean" } } },
      },
    };
    const api = client();

    const first = await api.complete({ messages: [{ role: "user", content: "Who is on?" }], tools: [tool] });
    expect(first.message.toolCalls?.[0]).toEqual({
      id: "call_1",
      name: "players",
      arguments: { online: true },
      argumentsJson: "{\"online\":true}",
    });
    await api.complete({
      messages: [
        { role: "user", content: "Who is on?" },
        first.message,
        { role: "tool", toolCallId: "call_1", name: "players", content: "{\"count\":3}" },
      ],
      tools: [tool],
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const followUpBody = JSON.parse(String(calls[1]![1].body));
    expect(followUpBody.messages[1].tool_calls[0]).toMatchObject({
      id: "call_1",
      function: { name: "players", arguments: "{\"online\":true}" },
    });
    expect(followUpBody.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      name: "players",
      content: "{\"count\":3}",
    });
  });

  it("returns normalized token and cost usage when OpenRouter supplies it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        completion_tokens_details: { reasoning_tokens: 7 },
        cost: 0.00042,
      },
    }))));

    await expect(client().complete({ messages: [{ role: "user", content: "Hi" }] }))
      .resolves.toMatchObject({
        usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125, reasoningTokens: 7, costUsd: 0.00042 },
      });
  });

  it("returns a typed safe HTTP error without exposing the provider body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "upstream included sensitive prompt text" } }),
      { status: 429 },
    )));

    const error = await client().complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error).toMatchObject({ code: "http_error", status: 429, retryable: true });
    expect(String(error)).not.toContain("sensitive prompt text");
  });

  it("retries one transient provider failure within the original deadline", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client({ maxRetries: 1 }).complete({ messages: [{ role: "user", content: "Hi" }] }))
      .resolves.toMatchObject({ message: { content: "Recovered" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry rate limits or extend a timed-out request", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client({ maxRetries: 1 }).complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out a hung request", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const error = await client({ timeoutMs: 5 })
      .complete({ messages: [{ role: "user", content: "Hi" }] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "timeout", retryable: true });
  });

  it("keeps the timeout active while consuming the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      });
      return new Response(stream);
    }));

    await expect(client({ timeoutMs: 5 }).complete({
      messages: [{ role: "user", content: "Hi" }],
    })).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("rejects malformed tool arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: { name: "players", arguments: "not json" },
          }],
        },
      }],
    }))));

    await expect(client().complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects.toMatchObject({ code: "malformed_response", retryable: false });
  });

  it("bounds response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(50))));

    await expect(client({ maxResponseBytes: 10 }).complete({
      messages: [{ role: "user", content: "Hi" }],
    })).rejects.toMatchObject({ code: "response_too_large" });
  });
});
