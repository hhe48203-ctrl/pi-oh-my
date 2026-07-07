import { describe, expect, it } from "vitest";

import { activateSubagentTools, registerSubagentToolActivation, SUBAGENT_ACTIVE_TOOLS } from "./index.ts";

describe("activateSubagentTools", () => {
  it("adds subagent tools to the active tool list", () => {
    let activeTools = ["read", "bash"];

    activateSubagentTools({
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
    });

    expect(activeTools).toEqual(["read", "bash", ...SUBAGENT_ACTIVE_TOOLS]);
  });

  it("does not duplicate already active subagent tools", () => {
    let activeTools = ["read", "subagent", "spawn_bg"];

    activateSubagentTools({
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
    });

    expect(activeTools).toEqual(["read", "subagent", "spawn_bg", "subagent_async", "check_spawn", "bash_bg", "check_bg"]);
  });
});

describe("registerSubagentToolActivation", () => {
  it("activates subagent tools on session start", () => {
    let handler: (() => void) | undefined;
    let activeTools = ["read"];

    registerSubagentToolActivation({
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
      on: (_event, nextHandler) => {
        handler = nextHandler;
      },
    });
    handler?.();

    expect(activeTools).toEqual(["read", ...SUBAGENT_ACTIVE_TOOLS]);
  });
});
