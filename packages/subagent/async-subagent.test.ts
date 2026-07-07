import { describe, expect, it } from "vitest";
import { getFinalAssistantText, parseToolList, resolveModel } from "./async-subagent.ts";

describe("parseToolList", () => {
  it("trims comma-separated tool names", () => {
    expect(parseToolList(" read, grep,,ls ")).toEqual(["read", "grep", "ls"]);
  });
});

describe("getFinalAssistantText", () => {
  it("returns the latest assistant text", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "old" }],
        api: "openai-responses",
        provider: "openai",
        model: "a",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "new\n" }],
        api: "openai-responses",
        provider: "openai",
        model: "a",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 3,
      },
    ] as const;

    expect(getFinalAssistantText(messages)).toBe("new");
  });
});

describe("resolveModel", () => {
  it("uses current model when no override is requested", () => {
    const currentModel = {
      id: "m1",
      name: "Model One",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } as const;
    const registry = {
      find: () => undefined,
      getAll: () => [],
    };

    expect(resolveModel(registry, currentModel, undefined)).toBe(currentModel);
  });
});
