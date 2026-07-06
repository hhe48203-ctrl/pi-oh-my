import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_TIMEOUT_MS, DEFAULT_TOOLS, EXCLUDED_CHILD_TOOLS, KILL_GRACE_MS, SUBAGENT_PROMPT } from "./constants.ts";

const MAX_STORED_OUTPUT = 100_000;
const MAX_CHECK_OUTPUT = 10_000;
const MAX_BG_TASKS = 4;

export interface BgTask {
  id: string;
  kind: "bash" | "subagent";
  label: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  forceKillTimer: ReturnType<typeof setTimeout> | undefined;
}

const bgTasks = new Map<string, BgTask>();

export function isTaskFinished(task: BgTask): boolean {
  return task.finishedAt !== null;
}

export function appendOutput(buf: string, chunk: string): string {
  const s = buf + chunk;
  return s.length > MAX_STORED_OUTPUT ? s.slice(-MAX_STORED_OUTPUT) : s;
}

export function activeTaskCount(): number {
  let count = 0;
  for (const task of bgTasks.values()) {
    if (!isTaskFinished(task)) count += 1;
  }
  return count;
}

function signalTask(task: BgTask, signal: NodeJS.Signals): void {
  if (isTaskFinished(task)) return;
  if (process.platform !== "win32" && task.child.pid !== undefined) {
    try {
      process.kill(-task.child.pid, signal);
      return;
    } catch (e) {
      if (e instanceof Error) {
        task.stderr = appendOutput(task.stderr, `\n[${signal} failed for process group: ${e.message}]\n`);
      } else {
        throw e;
      }
    }
  }
  task.child.kill(signal);
}

function terminateTask(task: BgTask): void {
  signalTask(task, "SIGTERM");
  task.forceKillTimer = setTimeout(() => {
    signalTask(task, "SIGKILL");
  }, KILL_GRACE_MS);
}

function spawnBgTask(
  kind: "bash" | "subagent",
  label: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): string {
  if (activeTaskCount() >= MAX_BG_TASKS) {
    throw new Error(`Too many background tasks running. Limit: ${MAX_BG_TASKS}.`);
  }

  const id = randomUUID().slice(0, 8);
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const task: BgTask = {
    id, kind, label, child,
    stdout: "", stderr: "",
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutTimer: undefined,
    forceKillTimer: undefined,
  };

  child.stdout?.on("data", (d: Buffer) => { task.stdout = appendOutput(task.stdout, d.toString()); });
  child.stderr?.on("data", (d: Buffer) => { task.stderr = appendOutput(task.stderr, d.toString()); });

  task.timeoutTimer = setTimeout(() => {
    task.timedOut = true;
    terminateTask(task);
  }, timeoutMs);

  child.on("error", (e: Error) => {
    task.finishedAt = Date.now();
    task.exitCode = -1;
    task.stderr = appendOutput(task.stderr, `\n[spawn error: ${e.message}]\n`);
  });
  child.on("close", (code, sig) => {
    task.finishedAt = Date.now();
    task.exitCode = code;
    task.signal = sig;
    clearTimeout(task.timeoutTimer);
    if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
  });

  child.unref();
  bgTasks.set(id, task);
  return id;
}

export function formatTaskStatus(task: BgTask): string {
  const now = Date.now();
  const elapsed = ((task.finishedAt ?? now) - task.startedAt) / 1000;
  let status: string;
  if (task.finishedAt !== null) {
    const end = task.signal ? `signal ${task.signal}` : `exit ${task.exitCode}`;
    if (task.timedOut) status = `timed out (${end})`;
    else if (task.exitCode === 0) status = "completed";
    else status = `failed (${end})`;
  } else {
    status = task.timedOut ? "timing out (killing...)" : "running";
  }

  const lines = [
    `Task: ${task.label}`,
    `Kind: ${task.kind}`,
    `Status: ${status}`,
    `Elapsed: ${elapsed.toFixed(1)}s`,
  ];
  const out = task.stdout.trim();
  if (out) lines.push("", "--- output ---", out.length > MAX_CHECK_OUTPUT ? `...${out.slice(-MAX_CHECK_OUTPUT)}` : out);
  const err = task.stderr.trim();
  if (err) lines.push("", "--- stderr ---", err.length > MAX_CHECK_OUTPUT ? `...${err.slice(-MAX_CHECK_OUTPUT)}` : err);
  return lines.join("\n");
}

function checkTask(taskId: string, kind: BgTask["kind"]): string | null {
  const task = bgTasks.get(taskId);
  if (!task || task.kind !== kind) return null;
  const text = formatTaskStatus(task);
  if (isTaskFinished(task)) bgTasks.delete(taskId);
  return text;
}

export function registerBackgroundTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn_bg",
    label: "Spawn Background Subagent",
    description:
      "Spawn a subagent in the background — returns immediately with a task_id. The subagent runs in an isolated process with its own session. Does NOT block the agent loop — you can continue working and check the result later with `check_spawn`. Best for long-running tasks (code review, test suites, deep exploration) that don't need immediate results.",
    executionMode: "parallel",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task for the subagent. Must be self-contained." }),
      description: Type.String({ description: "Short 3-8 word description, e.g. 'review auth module'" }),
      tools: Type.Optional(Type.String({ description: `Comma-separated tool allowlist. Default: ${DEFAULT_TOOLS} (read-only).` })),
      model: Type.Optional(Type.String({ description: "Model pattern for the subagent." })),
      timeoutMs: Type.Optional(Type.Number({ description: `Max runtime in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const { prompt, tools, model, timeoutMs } = params;
      const allow = tools || DEFAULT_TOOLS;
      const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      const args = ["-p", "--no-session", "--tools", allow, "--exclude-tools", EXCLUDED_CHILD_TOOLS, "--append-system-prompt", SUBAGENT_PROMPT];
      if (model) args.push("--model", model);
      args.push(prompt);
      try {
        const id = spawnBgTask("subagent", params.description, "pi", args, ctx.cwd, timeout);
        return {
          content: [{
            type: "text" as const,
            text: `Background subagent started.\nTask ID: ${id}\nDescription: ${params.description}\nCheck with: check_spawn({ task_id: "${id}" })`,
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `Failed to start: ${msg}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "check_spawn",
    label: "Check Background Subagent",
    description:
      "Check the status and output of a background subagent started with `spawn_bg`. Returns current status (running/completed/failed/timed out), elapsed time, and output so far. If still running, do other work and check again later.",
    executionMode: "parallel",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by spawn_bg" }),
    }),
    execute: async (_id, params) => {
      const text = checkTask(params.task_id, "subagent");
      if (text === null) {
        return { content: [{ type: "text" as const, text: `Task ${params.task_id} not found or not a subagent task.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  });

  pi.registerTool({
    name: "bash_bg",
    label: "Background Bash",
    description:
      "Execute a bash command in the background — returns immediately with a task_id. Does NOT block the agent loop. Best for long-running commands (test suites, builds, dev servers, file watches). Check the result later with `check_bg`. For quick commands, use the regular `bash` tool instead.",
    executionMode: "parallel",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute in the background" }),
      label: Type.Optional(Type.String({ description: "Short description for the task. Defaults to first 40 chars of command." })),
      timeoutMs: Type.Optional(Type.Number({ description: `Max runtime in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const { command, label, timeoutMs } = params;
      const taskLabel = label || command.slice(0, 40);
      const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      try {
        const id = spawnBgTask("bash", taskLabel, "bash", ["-c", command], ctx.cwd, timeout);
        return {
          content: [{
            type: "text" as const,
            text: `Background task started.\nTask ID: ${id}\nLabel: ${taskLabel}\nCheck with: check_bg({ task_id: "${id}" })`,
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `Failed to start: ${msg}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "check_bg",
    label: "Check Background Bash",
    description:
      "Check the status and output of a background bash command started with `bash_bg`. Returns current status (running/completed/failed/timed out), elapsed time, and output so far. If still running, do other work and check again later.",
    executionMode: "parallel",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by bash_bg" }),
    }),
    execute: async (_id, params) => {
      const text = checkTask(params.task_id, "bash");
      if (text === null) {
        return { content: [{ type: "text" as const, text: `Task ${params.task_id} not found or not a bash task.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  });

  pi.on("session_shutdown", () => {
    for (const task of bgTasks.values()) {
      if (!isTaskFinished(task)) terminateTask(task);
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    }
    bgTasks.clear();
  });
}
