import { describe, expect, it } from "vitest";
import { appendStderr, stderrTail } from "./index.ts";

describe("stderrTail", () => {
  it("returns an empty string when there is no stderr", () => {
    expect(stderrTail("   \n  ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(stderrTail("\n  Request timed out.\n ")).toBe("Request timed out.");
  });

  it("keeps only the trailing chars when longer than the cap", () => {
    const long = `${"a".repeat(50)}TAIL`;
    expect(stderrTail(long, 8)).toBe("...aaaaTAIL");
  });
});

describe("appendStderr", () => {
  it("returns the message unchanged when stderr is empty", () => {
    expect(appendStderr("Subagent timed out.", "  ")).toBe("Subagent timed out.");
  });

  it("appends a labeled stderr tail when present", () => {
    expect(appendStderr("Subagent timed out.", "Request timed out.")).toBe(
      "Subagent timed out.\n\n--- subagent stderr ---\nRequest timed out.",
    );
  });
});
