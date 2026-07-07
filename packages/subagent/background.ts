import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderToolCall, renderToolResult } from "../tool-render.ts";
import {
  DEFAULT_BASH_LABEL_PREVIEW_CHARS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  EXCLUDED_CHILD_TOOLS,
  SUBAGENT_PROMPT,
} from "./constants.ts";
import { checkTask, rememberBackgroundContext, shutdownBackgroundTasks, spawnBgTask } from "./background-runtime.ts";

export {
  appendOutput,
  formatTaskPanelLines,
  formatTaskStatus,
  isTaskFinished,
  type BgTask,
  type BgTaskSnapshot,
} from "./background-runtime.ts";

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
    renderCall(args, theme) {
      return renderToolCall(theme, "spawn_bg", args.description);
    },
    renderResult(result, options, theme) {
      return renderToolResult(theme, result, { expanded: options.expanded });
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      rememberBackgroundContext(ctx);
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
            text: `Background subagent started: ${id}\nDescription: ${params.description}\nCheck with: check_spawn task_id=${id}`,
          }],
          details: { taskId: id, kind: "subagent", label: params.description },
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
    renderCall(args, theme) {
      return renderToolCall(theme, "check_spawn", `task_id=${args.task_id}`);
    },
    renderResult(result, options, theme) {
      return renderToolResult(theme, result, { expanded: options.expanded });
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      rememberBackgroundContext(ctx);
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
      label: Type.Optional(Type.String({ description: `Short description for the task. Defaults to first ${DEFAULT_BASH_LABEL_PREVIEW_CHARS} chars of command.` })),
      timeoutMs: Type.Optional(Type.Number({ description: `Max runtime in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
    }),
    renderCall(args, theme) {
      return renderToolCall(theme, "bash_bg", args.label || args.command);
    },
    renderResult(result, options, theme) {
      return renderToolResult(theme, result, { expanded: options.expanded });
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      rememberBackgroundContext(ctx);
      const { command, label, timeoutMs } = params;
      const taskLabel = label || command.slice(0, DEFAULT_BASH_LABEL_PREVIEW_CHARS);
      const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      try {
        const id = spawnBgTask("bash", taskLabel, "bash", ["-c", command], ctx.cwd, timeout);
        return {
          content: [{
            type: "text" as const,
            text: `Background task started: ${id}\nLabel: ${taskLabel}\nCheck with: check_bg task_id=${id}`,
          }],
          details: { taskId: id, kind: "bash", label: taskLabel },
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
    renderCall(args, theme) {
      return renderToolCall(theme, "check_bg", `task_id=${args.task_id}`);
    },
    renderResult(result, options, theme) {
      return renderToolResult(theme, result, { expanded: options.expanded });
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      rememberBackgroundContext(ctx);
      const text = checkTask(params.task_id, "bash");
      if (text === null) {
        return { content: [{ type: "text" as const, text: `Task ${params.task_id} not found or not a bash task.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    rememberBackgroundContext(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    shutdownBackgroundTasks(ctx);
  });
}
