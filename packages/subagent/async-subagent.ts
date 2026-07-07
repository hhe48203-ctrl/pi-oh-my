import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  EXCLUDED_CHILD_TOOLS,
  SUBAGENT_PROMPT,
} from "./constants.ts";

export type InProcessSubagentOptions = {
  readonly cwd: string;
  readonly prompt: string;
  readonly tools?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly currentModel: Model<Api> | undefined;
  readonly modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  readonly signal?: AbortSignal | undefined;
};

type InProcessSubagentResult = {
  readonly text: string;
  readonly timedOut: boolean;
  readonly stopReason: string | undefined;
};

export function parseToolList(tools: string): string[] {
  return tools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

export function getFinalAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text.trim();
    }
  }
  return "";
}

export function resolveModel(
  modelRegistry: ExtensionContext["modelRegistry"] | undefined,
  currentModel: Model<Api> | undefined,
  requested: string | undefined,
): Model<Api> | undefined {
  if (!requested) return currentModel;
  if (!modelRegistry) return undefined;
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const modelId = requested.slice(slash + 1);
    return modelRegistry.find(provider, modelId);
  }
  return modelRegistry.getAll().find((model) => model.id === requested || model.name === requested);
}

export async function runInProcessSubagent(options: InProcessSubagentOptions): Promise<InProcessSubagentResult> {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const selectedModel = resolveModel(options.modelRegistry, options.currentModel, options.model);

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model: selectedModel,
    modelRegistry: options.modelRegistry,
    tools: parseToolList(options.tools ?? DEFAULT_TOOLS),
    excludeTools: parseToolList(EXCLUDED_CHILD_TOOLS),
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, timeoutMs);
  const abort = () => {
    void session.abort();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(`${SUBAGENT_PROMPT}\n\nTask: ${options.prompt}`);
    const messages = session.messages.filter((message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult"
    );
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return {
      text: getFinalAssistantText(messages) || "Subagent produced no output.",
      timedOut,
      stopReason: lastAssistant?.stopReason,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

export function registerAsyncSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_async",
    label: "Async Subagent",
    description:
      "Run a subagent as an in-process async Pi session instead of spawning a child pi process. It still has a fresh in-memory session and isolated context, but shares the current Node process/runtime. Blocks until the subagent completes; use it to compare process overhead with `subagent`.",
    executionMode: "parallel",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task for the subagent. Must be self-contained." }),
      description: Type.String({ description: "Short 3-8 word description, e.g. 'review auth module'" }),
      tools: Type.Optional(Type.String({ description: `Comma-separated tool allowlist. Default: ${DEFAULT_TOOLS}.` })),
      model: Type.Optional(Type.String({ description: "Exact model id or provider/model id. Defaults to current model." })),
      timeoutMs: Type.Optional(Type.Number({ description: `Maximum runtime in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
    }),
    promptGuidelines: [
      "Use `subagent_async` to test in-process subagent overhead against process-spawned `subagent`.",
      "Prompts must be self-contained; the child session does not inherit conversation history.",
    ],
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const result = await runInProcessSubagent({
          cwd: ctx.cwd,
          prompt: params.prompt,
          tools: params.tools,
          model: params.model,
          timeoutMs: params.timeoutMs,
          currentModel: ctx.model,
          modelRegistry: ctx.modelRegistry,
          signal,
        });
        if (result.timedOut) {
          return {
            content: [{ type: "text" as const, text: `Subagent timed out after ${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.` }],
            isError: true,
          };
        }
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          return { content: [{ type: "text" as const, text: result.text }], isError: true };
        }
        return { content: [{ type: "text" as const, text: result.text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `In-process subagent failed: ${message}` }], isError: true };
      }
    },
  });
}
