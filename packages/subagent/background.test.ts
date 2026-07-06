import { describe, it, expect } from "vitest";
import { appendOutput, formatTaskStatus, isTaskFinished, type BgTask } from "./background.ts";

// Helper: create a minimal fake BgTask (no real child process)
function makeFakeTask(overrides: Partial<BgTask> = {}): BgTask {
  return {
    id: "test123",
    kind: "bash",
    label: "test task",
    child: { kill: () => {}, unref: () => {}, pid: 99999 } as any,
    stdout: "",
    stderr: "",
    startedAt: Date.now() - 5000,
    finishedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutTimer: undefined,
    forceKillTimer: undefined,
    ...overrides,
  };
}

describe("appendOutput", () => {
  it("concatenates strings", () => {
    expect(appendOutput("hello", " world")).toBe("hello world");
  });

  it("handles empty buffer", () => {
    expect(appendOutput("", "data")).toBe("data");
  });

  it("handles empty chunk", () => {
    expect(appendOutput("data", "")).toBe("data");
  });

  it("truncates at 100KB keeping the tail", () => {
    const chunk = "x".repeat(50000);
    let buf = "";
    buf = appendOutput(buf, chunk);
    buf = appendOutput(buf, chunk);
    buf = appendOutput(buf, chunk);
    expect(buf.length).toBe(100000);
    // Should keep the last 100KB
    expect(buf).toBe("x".repeat(100000));
  });

  it("handles large chunk in one call", () => {
    const chunk = "y".repeat(150000);
    const buf = appendOutput("", chunk);
    expect(buf.length).toBe(100000);
    expect(buf.startsWith("y")).toBe(true);
  });
});

describe("isTaskFinished", () => {
  it("returns false for running task", () => {
    expect(isTaskFinished(makeFakeTask({ finishedAt: null }))).toBe(false);
  });

  it("returns true for finished task", () => {
    expect(isTaskFinished(makeFakeTask({ finishedAt: Date.now(), exitCode: 0 }))).toBe(true);
  });
});

describe("formatTaskStatus", () => {
  it("shows 'running' for active task", () => {
    const task = makeFakeTask({ finishedAt: null });
    const status = formatTaskStatus(task);
    expect(status).toContain("Status: running");
    expect(status).toContain("Elapsed:");
    expect(status).toContain("test task");
  });

  it("shows 'completed' for exit code 0", () => {
    const task = makeFakeTask({ finishedAt: Date.now(), exitCode: 0 });
    const status = formatTaskStatus(task);
    expect(status).toContain("Status: completed");
  });

  it("shows 'failed' for non-zero exit", () => {
    const task = makeFakeTask({ finishedAt: Date.now(), exitCode: 1 });
    const status = formatTaskStatus(task);
    expect(status).toContain("Status: failed");
    expect(status).toContain("exit 1");
  });

  it("shows 'timed out' for timedOut task", () => {
    const task = makeFakeTask({ finishedAt: Date.now(), exitCode: null, signal: "SIGTERM", timedOut: true });
    const status = formatTaskStatus(task);
    expect(status).toContain("Status: timed out");
  });

  it("includes stdout when present", () => {
    const task = makeFakeTask({ stdout: "line1\nline2" });
    const status = formatTaskStatus(task);
    expect(status).toContain("--- output ---");
    expect(status).toContain("line1");
    expect(status).toContain("line2");
  });

  it("includes stderr when present", () => {
    const task = makeFakeTask({ stderr: "warning!" });
    const status = formatTaskStatus(task);
    expect(status).toContain("--- stderr ---");
    expect(status).toContain("warning!");
  });

  it("includes kind label", () => {
    const task = makeFakeTask({ kind: "subagent" });
    expect(formatTaskStatus(task)).toContain("Kind: subagent");
  });

  it("does not include output section when empty", () => {
    const task = makeFakeTask({ stdout: "", stderr: "" });
    const status = formatTaskStatus(task);
    expect(status).not.toContain("--- output ---");
    expect(status).not.toContain("--- stderr ---");
  });
});
