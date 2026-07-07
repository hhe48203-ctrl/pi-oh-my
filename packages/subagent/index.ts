/**
 * pi-oh-my-subagent: Subagent + background task tools for Pi.
 *
 * Tools:
 * - subagent:    Blocking parallel subagent (waits for result)
 * - spawn_bg:    Non-blocking subagent (returns task_id immediately)
 * - check_spawn: Check spawn_bg task status and output
 * - bash_bg:     Non-blocking bash command (returns task_id immediately)
 * - check_bg:    Check bash_bg task status and output
 *
 * Background tasks run in detached processes — they don't block the agent loop.
 * The LLM polls with check_bg / check_spawn to get results.
 */

import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsyncSubagentTool } from "./async-subagent.ts";
import { registerBackgroundTools } from "./background.ts";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  EXCLUDED_CHILD_TOOLS,
  KILL_GRACE_MS,
  SUBAGENT_PROMPT,
} from "./constants.ts";

// ─── Extension ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── 1. subagent (blocking, parallel) ──────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a parallel subagent in an isolated process. The subagent gets its own session, context, and tools — it does NOT inherit your conversation history. Best for parallel independent tasks (code review, exploration, multi-perspective analysis). Returns the subagent's final text response. Blocks until the subagent completes.",
    executionMode: "parallel",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task for the subagent. Must be self-contained — the subagent has zero context beyond this prompt." }),
      description: Type.String({ description: "Short 3-8 word description, e.g. 'review auth module'" }),
      tools: Type.Optional(Type.String({ description: `Comma-separated tool allowlist. Default: ${DEFAULT_TOOLS} (read-only). Add bash,edit,write for write access.` })),
      model: Type.Optional(Type.String({ description: "Model pattern for the subagent, e.g. 'claude-sonnet-4'. Defaults to current model." })),
      timeoutMs: Type.Optional(Type.Number({ description: `Maximum runtime in ms before killing the subagent. Default: ${DEFAULT_TIMEOUT_MS}.` })),
    }),
    promptGuidelines: [
      "Use `subagent` for parallel, independent tasks — not sequential work.",
      "Each subagent prompt must be fully self-contained (no shared context).",
      "Multiple `subagent` calls in one turn execute in parallel.",
      `Subagents are read-only by default (${DEFAULT_TOOLS}); add bash,edit,write for write access.`,
      "For non-blocking subagents, use `spawn_bg` + `check_spawn` instead.",
    ],
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const { prompt, tools, model, timeoutMs } = params;
      const allow = tools || DEFAULT_TOOLS;
      const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

      const args = ["-p", "--no-session", "--tools", allow, "--exclude-tools", EXCLUDED_CHILD_TOOLS, "--append-system-prompt", SUBAGENT_PROMPT];
      if (model) args.push("--model", model);
      args.push(prompt);

      const child = spawn("pi", args, { cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"] });

      let timedOut = false;
      let childClosed = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const terminateChild = () => {
        if (childClosed) return;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => { if (!childClosed) child.kill("SIGKILL"); }, KILL_GRACE_MS);
      };
      const onAbort = () => terminateChild();
      if (signal?.aborted) terminateChild();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutTimer = setTimeout(() => { timedOut = true; terminateChild(); }, timeout);

      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => { out += d; });
      child.stderr?.on("data", (d: Buffer) => { err += d; });

      try {
        const r = await new Promise<{ code: number | null; sig: string | null; error: Error | null }>((resolve) => {
          child.on("error", (error) => resolve({ code: -1, sig: null, error }));
          child.on("close", (code, sig) => { childClosed = true; resolve({ code, sig, error: null }); });
        });
        if (r.error) {
          const hint = r.error.message.includes("ENOENT") ? " Is 'pi' in PATH?" : "";
          return { content: [{ type: "text" as const, text: `Subagent failed to start: ${r.error.message}${hint}` }], isError: true };
        }
        if (r.sig) {
          if (timedOut) return { content: [{ type: "text" as const, text: `Subagent timed out after ${timeout}ms and was killed.` }], isError: true };
          return { content: [{ type: "text" as const, text: "Subagent aborted." }], isError: true };
        }
        if (r.code !== 0 && !out.trim()) {
          return { content: [{ type: "text" as const, text: `Subagent failed (exit ${r.code}).\n${err.trim()}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: out.trim() || "Subagent produced no output." }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `Subagent error: ${msg}` }], isError: true };
      } finally {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });

  registerAsyncSubagentTool(pi);
  registerBackgroundTools(pi);
}
