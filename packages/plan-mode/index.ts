/**
 * Plan Mode — Read-only exploration → plan → execute
 *
 * /plan or Ctrl+Alt+P toggles a read-only mode where edit/write are
 * disabled and bash is restricted to safe read-only commands.
 *
 * The agent uses update_plan (from the update-plan extension) to create
 * a structured checklist. After exploration, the user chooses to execute
 * or refine.
 *
 * Requires: pi-oh-my-update-plan installed (for the update_plan tool).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// ── Tools ──────────────────────────────────────────────────────────

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_DISABLED = new Set(["edit", "write"]);
const MANAGED = new Set([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// ── Bash command safety (from pi's plan-mode example) ──────────────

const DESTRUCTIVE = [
	/\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i,
	/\btouch\b/i, /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i,
	/\btee\b/i, /\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
	/(^|[^<])>(?!>)/, />>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
	/\breboot\b/i, /\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
	/^\s*file\b/, /^\s*tree\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/,
	/^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*eza\b/, /^\s*jq\b/,
	/^\s*sed\s+-n/i, /^\s*awk\b/,
	/^\s*git\s+(status|log|diff|branch|show|blame|remote|stash\s+list|reflog)/i,
	/^\s*npm\s+(list|outdated|info|view|ls)/i,
	/^\s*python\s+--version/i, /^\s*node\s+--version/i, /^\s*node\s+-v\b/,
	/^\s*uname\b/, /^\s*whoami\b/, /^\s*date\b/, /^\s*uptime\b/,
	/^\s*curl\s/i, /^\s*wget\s+-O\s*-/i,
];

function isSafeCommand(command: string): boolean {
	const destructive = DESTRUCTIVE.some((p) => p.test(command));
	const safe = SAFE.some((p) => p.test(command));
	return !destructive && safe;
}

// ── State ───────────────────────────────────────────────────────────

interface PlanModeState {
	enabled: boolean;
	toolsBefore?: string[];
}

let planState: PlanModeState = { enabled: false };

// ── Extension ───────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ── State reconstruction ───────────────────────────────────────
	const reconstruct = (ctx: ExtensionContext): void => {
		planState = { enabled: false };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== "plan-mode") continue;
			const d = entry.data as PlanModeState | undefined;
			if (d) planState = d;
		}
		if (planState.enabled) {
			// Re-apply read-only tools
			planState.toolsBefore = pi.getActiveTools();
			applyPlanModeTools();
		}
		refreshStatus(ctx);
	};

	pi.on("session_start", (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// ── Tool management ────────────────────────────────────────────
	function unique(names: string[]): string[] {
		return [...new Set(names)];
	}

	function applyPlanModeTools(): void {
		const current = pi.getActiveTools();
		pi.setActiveTools(
			unique([
				...current.filter((n) => !PLAN_DISABLED.has(n)),
				...PLAN_MODE_TOOLS,
			]),
		);
	}

	function restoreNormalTools(): void {
		const before = planState.toolsBefore ?? NORMAL_MODE_TOOLS;
		pi.setActiveTools(
			unique([
				...NORMAL_MODE_TOOLS,
				...before.filter((n) => !MANAGED.has(n)),
			]),
		);
	}

	// ── Toggle ─────────────────────────────────────────────────────
	function toggle(ctx: ExtensionContext): void {
		if (planState.enabled) {
			// Turn off plan mode
			planState.enabled = false;
			restoreNormalTools();
			ctx.ui.notify("Plan mode off. Full access restored.", "info");
		} else {
			// Turn on plan mode
			planState.enabled = true;
			planState.toolsBefore = pi.getActiveTools();
			applyPlanModeTools();
			ctx.ui.notify(
				"Plan mode on. Read-only. Ask the agent to explore and create a plan with update_plan.",
				"info",
			);
		}
		pi.appendEntry("plan-mode", planState);
		refreshStatus(ctx);
	}

	// ── Commands & shortcuts ───────────────────────────────────────
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: (ctx) => toggle(ctx),
	});

	// ── Block destructive bash in plan mode ────────────────────────
	pi.on("tool_call", (event) => {
		if (!planState.enabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason:
					`Plan mode: command blocked (not allowlisted).\n` +
					`Command: ${command}\n` +
					`Use /plan to disable plan mode first.`,
			};
		}
	});

	// ── Inject plan mode context ───────────────────────────────────
	pi.on("before_agent_start", () => {
		if (!planState.enabled) return;
		return {
			message: {
				customType: "plan-mode-context",
				content:
					"[PLAN MODE ACTIVE] Read-only exploration. Do NOT make changes.\n" +
					"Explore the codebase, then call update_plan with a numbered checklist of steps.\n" +
					"Each step must be outcome-oriented and verifiable.\n" +
					"Do not execute the plan yet — just create it.",
				display: false,
			},
		};
	});

	// ── Clean up stale context when not in plan mode ──────────────
	pi.on("context", (event) => {
		if (planState.enabled) return;
		return {
			messages: event.messages.filter((m) => {
				const customMsg = m as { customType?: string };
				if (customMsg.customType?.startsWith("plan-mode-")) return false;
				return true;
			}),
		};
	});

	// ── After agent finishes in plan mode, offer execute ───────────
	pi.on("agent_end", async (_event, ctx) => {
		if (!planState.enabled || !ctx.hasUI) return;

		// Check if there's a plan (via update_plan tool results)
		let hasPlan = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "update_plan") {
				const d = msg.details as { plan?: unknown[] } | undefined;
				if (d?.plan?.length) hasPlan = true;
			}
		}

		if (!hasPlan) return;

		const choice = await ctx.ui.select("Plan created — what next?", [
			"Execute the plan (restore full tools)",
			"Refine the plan (stay in plan mode)",
			"Stay in plan mode",
		]);

		if (choice?.startsWith("Execute")) {
			planState.enabled = false;
			restoreNormalTools();
			pi.appendEntry("plan-mode", planState);
			refreshStatus(ctx);
			// Trigger execution with a follow-up message
			pi.sendUserMessage(
				"Execute the plan. Use update_plan to track progress as you complete each step.",
				{ deliverAs: "followUp" },
			);
		}
	});

	// ── Status bar ────────────────────────────────────────────────
	function refreshStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"plan-mode",
			planState.enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
		);
	}
}
