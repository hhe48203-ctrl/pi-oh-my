import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_TIMEOUT_MS, KILL_GRACE_MS } from "./constants.ts";

const MAX_STORED_OUTPUT = 100_000;
const MAX_CHECK_OUTPUT = 10_000;
const MAX_BG_TASKS = 4;
const MAX_PANEL_TASKS = 6;
const MAX_PANEL_LABEL = 44;
const BG_WIDGET_KEY = "bg-tasks";

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

export interface BgTaskSnapshot {
  readonly id: string;
  readonly kind: "bash" | "subagent";
  readonly label: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

const bgTasks = new Map<string, BgTask>();
let widgetContext: ExtensionContext | undefined;

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

function snapshotTask(task: BgTask): BgTaskSnapshot {
  return {
    id: task.id,
    kind: task.kind,
    label: task.label,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
  };
}

function taskStatus(task: BgTaskSnapshot): string {
  if (task.finishedAt === null) return task.timedOut ? "stopping" : "running";
  if (task.timedOut) return "timed out";
  if (task.exitCode === 0) return "completed";
  const end = task.signal ? `signal ${task.signal}` : `exit ${task.exitCode}`;
  return `failed (${end})`;
}

function elapsedSeconds(task: BgTaskSnapshot, now: number): string {
  return `${(((task.finishedAt ?? now) - task.startedAt) / 1000).toFixed(1)}s`;
}

function panelLabel(label: string): string {
  if (label.length <= MAX_PANEL_LABEL) return label;
  return `${label.slice(0, MAX_PANEL_LABEL - 3)}...`;
}

export function formatTaskPanelLines(tasks: readonly BgTaskSnapshot[], now = Date.now()): string[] {
  if (tasks.length === 0) return [];
  const visible = tasks.slice(0, MAX_PANEL_TASKS);
  const lines = ["Background Tasks"];
  for (const task of visible) {
    lines.push(
      `${taskStatus(task).padEnd(11)} ${task.id} ${task.kind.padEnd(8)} ${elapsedSeconds(task, now).padStart(6)} ${panelLabel(task.label)}`,
    );
  }
  const hidden = tasks.length - visible.length;
  if (hidden > 0) lines.push(`... ${hidden} more task${hidden === 1 ? "" : "s"}`);
  return lines;
}

function refreshBackgroundWidget(): void {
  if (!widgetContext) return;
  const lines = formatTaskPanelLines([...bgTasks.values()].map(snapshotTask));
  widgetContext.ui.setWidget(BG_WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
}

export function rememberBackgroundContext(ctx: ExtensionContext): void {
  widgetContext = ctx;
  refreshBackgroundWidget();
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

export function spawnBgTask(
  kind: "bash" | "subagent",
  label: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
    refreshBackgroundWidget();
  });
  child.on("close", (code, sig) => {
    task.finishedAt = Date.now();
    task.exitCode = code;
    task.signal = sig;
    clearTimeout(task.timeoutTimer);
    if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
    refreshBackgroundWidget();
  });

  child.unref();
  bgTasks.set(id, task);
  refreshBackgroundWidget();
  return id;
}

export function formatTaskStatus(task: BgTask): string {
  const now = Date.now();
  const elapsed = ((task.finishedAt ?? now) - task.startedAt) / 1000;
  const status = taskStatus(snapshotTask(task));
  const lines = [
    `${task.kind} ${task.id}: ${status} after ${elapsed.toFixed(1)}s - ${task.label}`,
    "",
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

export function checkTask(taskId: string, kind: BgTask["kind"]): string | null {
  const task = bgTasks.get(taskId);
  if (!task || task.kind !== kind) return null;
  const text = formatTaskStatus(task);
  if (isTaskFinished(task)) bgTasks.delete(taskId);
  refreshBackgroundWidget();
  return text;
}

export function shutdownBackgroundTasks(ctx: ExtensionContext): void {
  for (const task of bgTasks.values()) {
    if (!isTaskFinished(task)) terminateTask(task);
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
  }
  bgTasks.clear();
  widgetContext = ctx;
  refreshBackgroundWidget();
}
