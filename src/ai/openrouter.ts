export type JsonSchema = Record<string, unknown>;

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments supplied by the model. */
  arguments: Record<string, unknown>;
  /** Original JSON text, retained for an OpenAI-compatible follow-up message. */
  argumentsJson: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; name?: string };

export interface ChatCompletionRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[];
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  message: Extract<ChatMessage, { role: "assistant" }>;
  finishReason: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens: number;
    costUsd: number | null;
  };
}

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  /** API root; `/chat/completions` is appended. */
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxResponseBytes?: number;
  /** Retry count within the same overall timeout budget (maximum 1). */
  maxRetries?: number;
}

export type OpenRouterErrorCode =
  | "aborted"
  | "timeout"
  | "network_error"
  | "http_error"
  | "response_too_large"
  | "malformed_response";

/** Safe to log or show generically; it never contains credentials/provider bodies. */
export class OpenRouterError extends Error {
  constructor(
    readonly code: OpenRouterErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenRouter apiKey is required");
    if (!options.model.trim()) throw new Error("OpenRouter model is required");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxTokens = positiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens");
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.maxRetries = boundedRetryCount(options.maxRetries ?? 0);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const deadline = Date.now() + this.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new OpenRouterError("timeout", "OpenRouter request timed out", true);
      try {
        return await this.completeOnce(request, remainingMs);
      } catch (error) {
        if (attempt >= this.maxRetries || !shouldRetryWithinDeadline(error)) throw error;
      }
    }
  }

  private async completeOnce(request: ChatCompletionRequest, timeoutMs: number): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (request.signal?.aborted) controller.abort();

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages.map(wireMessage),
          ...(request.tools?.length ? { tools: request.tools } : {}),
          temperature: 0.1,
          max_tokens: this.maxTokens,
          provider: {
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        }),
        signal: controller.signal,
      });
      const body = await readBoundedBody(response, this.maxResponseBytes);
      if (!response.ok) {
        throw new OpenRouterError(
          "http_error",
          `OpenRouter request failed with HTTP ${response.status}`,
          response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
          response.status,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw malformed();
      }
      return parseCompletion(parsed);
    } catch (error) {
      if (error instanceof OpenRouterError) throw error;
      if (timedOut) {
        throw new OpenRouterError("timeout", "OpenRouter request timed out", true);
      }
      if (request.signal?.aborted) {
        throw new OpenRouterError("aborted", "OpenRouter request was cancelled", false);
      }
      throw new OpenRouterError("network_error", "OpenRouter request failed", true);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function shouldRetryWithinDeadline(error: unknown): boolean {
  return error instanceof OpenRouterError && error.retryable &&
    error.code !== "timeout" && error.code !== "aborted" && error.status !== 429;
}

function boundedRetryCount(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 1) throw new Error("maxRetries must be 0 or 1");
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    };
  }
  return message;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new OpenRouterError(
          "response_too_large",
          "OpenRouter response exceeded the allowed size",
          false,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseCompletion(value: unknown): ChatCompletionResult {
  const root = asRecord(value);
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw malformed();
  const choice = asRecord(choices[0]);
  const wire = asRecord(choice?.message);
  if (!wire || wire.role !== "assistant") throw malformed();
  if (wire.content !== null && typeof wire.content !== "string") throw malformed();

  let toolCalls: ToolCall[] | undefined;
  if (wire.tool_calls !== undefined) {
    if (!Array.isArray(wire.tool_calls)) throw malformed();
    toolCalls = wire.tool_calls.map(parseToolCall);
  }
  return {
    message: {
      role: "assistant",
      content: wire.content,
      ...(toolCalls?.length ? { toolCalls } : {}),
    },
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    ...parseUsage(root?.usage),
  };
}

function parseUsage(value: unknown): { usage?: ChatCompletionResult["usage"] } {
  const usage = asRecord(value);
  if (!usage) return {};
  const promptTokens = nonNegativeNumber(usage.prompt_tokens);
  const completionTokens = nonNegativeNumber(usage.completion_tokens);
  const totalTokens = nonNegativeNumber(usage.total_tokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) return {};
  const details = asRecord(usage.completion_tokens_details);
  const reasoningTokens = nonNegativeNumber(details?.reasoning_tokens) ?? 0;
  const costUsd = nonNegativeNumber(usage.cost);
  return { usage: { promptTokens, completionTokens, totalTokens, reasoningTokens, costUsd } };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseToolCall(value: unknown): ToolCall {
  const call = asRecord(value);
  const fn = asRecord(call?.function);
  if (
    !call ||
    typeof call.id !== "string" ||
    call.id.length === 0 ||
    call.type !== "function" ||
    !fn ||
    typeof fn.name !== "string" ||
    fn.name.length === 0 ||
    typeof fn.arguments !== "string"
  ) {
    throw malformed();
  }
  let args: unknown;
  try {
    args = JSON.parse(fn.arguments);
  } catch {
    throw malformed();
  }
  const argumentsRecord = asRecord(args);
  if (!argumentsRecord) throw malformed();
  return {
    id: call.id,
    name: fn.name,
    arguments: argumentsRecord,
    argumentsJson: fn.arguments,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function malformed(): OpenRouterError {
  return new OpenRouterError(
    "malformed_response",
    "OpenRouter returned an invalid response",
    false,
  );
}
