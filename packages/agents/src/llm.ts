import Anthropic from "@anthropic-ai/sdk";

/** One prompt in, one text reply out. The agent and reviewer only need this much. */
export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface Llm {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export class LlmRefusalError extends Error {}

export interface AnthropicLlmOptions {
  model?: string;
  /** Defaults to ANTHROPIC_API_KEY via the SDK's normal credential lookup. */
  apiKey?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

/**
 * Claude via the Anthropic SDK. Streams (code replies can be long) and enables
 * server-side refusal fallbacks so a policy decline is retried on a fallback model.
 */
export class AnthropicLlm implements Llm {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicLlmOptions["effort"]>;

  constructor(opts: AnthropicLlmOptions = {}) {
    this.name = opts.model ?? DEFAULT_MODEL;
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.effort = opts.effort ?? "medium";
  }

  async complete(req: LlmRequest): Promise<string> {
    const message = await this.client.beta.messages
      .stream({
        model: this.name,
        max_tokens: req.maxTokens ?? 32_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.effort },
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") throw new LlmRefusalError("model declined the request");
    if (message.stop_reason === "max_tokens") throw new Error("model reply hit max_tokens; output is incomplete");
    return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }
}

/** Deterministic stand-in for tests: replies come from a queue or a function. */
export class FakeLlm implements Llm {
  readonly name = "fake";
  readonly calls: LlmRequest[] = [];
  private readonly next: (req: LlmRequest, i: number) => string;

  constructor(replies: string[] | ((req: LlmRequest, i: number) => string)) {
    this.next = Array.isArray(replies)
      ? (_req, i) => {
          const r = replies[Math.min(i, replies.length - 1)];
          if (r === undefined) throw new Error("FakeLlm has no replies");
          return r;
        }
      : replies;
  }

  async complete(req: LlmRequest): Promise<string> {
    const reply = this.next(req, this.calls.length);
    this.calls.push(req);
    return reply;
  }
}
