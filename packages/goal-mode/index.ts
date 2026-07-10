/**
 * Goal Mode — Persistent objective tracking with auto-continue
 *
 * /goal <objective> sets a durable goal. While active, the agent
 * automatically continues turn after turn until the goal is complete,
 * blocked, or the turn budget is exhausted.
 *
 * The model gets two tools:
 *   get_goal    — read the current goal + budget
 *   update_goal — mark complete or blocked (cannot pause/resume/clear)
 *
 * /goal pause|resume|clear are user-controlled lifecycle commands.
 *
 * Works standalone; update-plan can be installed separately for step tracking.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalTools } from "./tools.ts";
import type { GoalState, GoalUpdateStatus } from "./state.ts";

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 40;

// ── Extension ───────────────────────────────────────────────────────

export default function goalModeExtension(pi: ExtensionAPI): void {
	let goal: GoalState | null = null;
	let continueScheduled = false;

	// ── State reconstruction ───────────────────────────────────────
	const reconstruct = (ctx: ExtensionContext): void => {
		goal = null;
		continueScheduled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== "goal-state") continue;
			const d = entry.data as GoalState | undefined;
			if (d) goal = d;
		}
		refreshStatus(ctx);
	};

	const activateTools = (): void => {
		const current = pi.getActiveTools();
		const toAdd = ["get_goal", "update_goal"].filter((n) => !current.includes(n));
		if (toAdd.length > 0) {
			pi.setActiveTools([...current, ...toAdd]);
		}
	};

	pi.on("session_start", (_e, ctx) => {
		reconstruct(ctx);
		activateTools();
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	registerGoalTools(pi, {
		getGoal: () => goal,
		updateGoal: (status: GoalUpdateStatus, reason: string | undefined, ctx: ExtensionContext) => {
			if (!goal) return null;
			goal.status = status;
			persist();
			refreshStatus(ctx);
			const message = reason
				? `Goal marked ${status}: ${reason}`
				: `Goal marked ${status}.`;
			return { message, goal };
		},
	});

	// ── /goal command ─────────────────────────────────────────────
	pi.registerCommand("goal", {
		description:
			"Set or manage a task goal: /goal <objective> | /goal | /goal pause|resume|clear",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			// No args → view current goal
			if (!trimmed) {
				if (!goal) {
					ctx.ui.notify("No goal set. Use: /goal <objective>", "info");
					return;
				}
				const remaining = goal.maxTurns - goal.turnsUsed;
				ctx.ui.notify(
					`[${goal.status}] ${goal.objective}\n` +
						`Turns: ${goal.turnsUsed}/${goal.maxTurns} (${remaining} left)`,
					"info",
				);
				return;
			}

			// Subcommands
			if (trimmed === "pause") {
				if (!goal) {
					ctx.ui.notify("No goal to pause.", "warning");
					return;
				}
				goal.status = "paused";
				persist();
				refreshStatus(ctx);
				ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
				return;
			}

			if (trimmed === "resume") {
				if (!goal) {
					ctx.ui.notify("No goal to resume.", "warning");
					return;
				}
				goal.status = "active";
				persist();
				refreshStatus(ctx);
				ctx.ui.notify("Goal resumed.", "info");
				scheduleContinue(ctx);
				return;
			}

			if (trimmed === "clear") {
				goal = null;
				continueScheduled = false;
				pi.appendEntry("goal-state", null);
				refreshStatus(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}

			// Otherwise → set new goal
			setGoal(trimmed, ctx);
		},
	});

	// ── Set goal ───────────────────────────────────────────────────
	function setGoal(objective: string, ctx: ExtensionContext): void {
		goal = {
			objective,
			status: "active",
			turnsUsed: 0,
			maxTurns: DEFAULT_MAX_TURNS,
			tokensUsed: 0,
			createdAt: Date.now(),
		};
		continueScheduled = false;
		persist();
		refreshStatus(ctx);
		ctx.ui.notify(`Goal set: ${objective}`, "info");

		// Trigger first turn
		pi.sendUserMessage(
			`Goal: ${objective}\n\n` +
				"Work toward this goal. Use update_plan to track your steps, " +
				"get_goal to check status/budget, and update_goal(complete) when done " +
				"or update_goal(blocked) if stuck.",
			{ deliverAs: "followUp" },
		);
	}

	// ── before_agent_start: inject goal context ───────────────────
	pi.on("before_agent_start", () => {
		// Reset the continue flag — the new turn is starting
		continueScheduled = false;
		if (!goal || goal.status !== "active") return;
		const remaining = goal.maxTurns - goal.turnsUsed;
		return {
			message: {
				customType: "goal-context",
				content:
					`[GOAL ACTIVE] ${goal.objective}\n` +
					`Turn ${goal.turnsUsed + 1}/${goal.maxTurns} (${remaining} remaining).\n` +
					`Continue making progress. Use update_plan for step tracking.\n` +
					`When the goal is verifiably met, call update_goal(complete).\n` +
					`If blocked, call update_goal(blocked).`,
				display: false,
			},
		};
	});

	// ── agent_end: budget + auto-continue ────────────────────────
	pi.on("agent_end", async (_event, ctx) => {
		if (!goal || goal.status !== "active") return;

		// Update budget
		goal.turnsUsed += 1;
		const usage = ctx.getContextUsage();
		if (usage?.tokens) {
			goal.tokensUsed = usage.tokens;
		}
		persist();

		// Budget exhausted → stop
		if (goal.turnsUsed >= goal.maxTurns) {
			goal.status = "blocked";
			persist();
			ctx.ui.notify(
				`Goal stopped: reached ${goal.maxTurns} turn limit. ` +
					`Use /goal clear or /goal resume with a higher budget.`,
				"warning",
			);
			refreshStatus(ctx);
			return;
		}

		// Auto-continue: schedule next turn
		scheduleContinue(ctx);
	});

	// ── Core: schedule continuation ───────────────────────────────
	function scheduleContinue(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") return;
		if (continueScheduled) return; // Already scheduled
		if (!ctx.isIdle()) return; // Don't queue while streaming

		continueScheduled = true;
		// Use sendMessage with triggerTurn to start next turn
		// display:false keeps it out of the visible TUI
		pi.sendMessage(
			{
				customType: "goal-continue",
				content: "Continue working on the goal.",
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	// ── Clean up stale goal context when not active ───────────────
	pi.on("context", (event) => {
		if (goal?.status === "active") return;
		return {
			messages: event.messages.filter((m) => {
				const customMsg = m as { customType?: string };
				if (customMsg.customType?.startsWith("goal-")) return false;
				return true;
			}),
		};
	});

	// ── Helpers ───────────────────────────────────────────────────
	function persist(): void {
		if (goal) {
			pi.appendEntry("goal-state", goal);
		}
	}

	function refreshStatus(ctx: ExtensionContext): void {
		if (!goal) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const icon =
			goal.status === "complete" ? "✅"
			: goal.status === "active" ? "🎯"
			: goal.status === "blocked" ? "🚫"
			: "⏸";
		const color =
			goal.status === "complete" ? "success"
			: goal.status === "active" ? "accent"
			: goal.status === "blocked" ? "error"
			: "dim";
		ctx.ui.setStatus(
			"goal",
			ctx.ui.theme.fg(color, `${icon} ${goal.turnsUsed}/${goal.maxTurns}`),
		);
	}
}
