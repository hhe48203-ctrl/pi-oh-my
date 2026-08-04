/**
 * Goal Mode — durable objective tracking driven by a linked update_plan.
 *
 * Goal owns continuation. Plan owns the current executable frontier. Fresh
 * Check contributes observable progress and independently guards completion.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { reconstructFreshCheckState } from "../fresh-check/index.ts";
import { isPlanModeToolAllowed, isSafeCommand } from "../plan-mode/index.ts";
import { reconstructPlanState, type PlanState } from "../update-plan/index.ts";
import {
	compactGoalMessages,
	continuationDelayMs,
	inspectGoalPlan,
	normalizeGoalState,
	readGoalUsage,
	type GoalPlanView,
	type GoalState,
	type GoalUpdateStatus,
} from "./state.ts";
import { registerGoalTools } from "./tools.ts";

interface ProgressSignals {
	plan: string;
	fresh: string;
}

export function reconstructGoalState(entries: Iterable<unknown>): GoalState | null {
	let goal: GoalState | null = null;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== "goal-state") continue;
		goal = candidate.data === null || candidate.data === undefined
			? null
			: normalizeGoalState(candidate.data) ?? goal;
	}
	return goal;
}

function latestGoalVersion(entries: Iterable<unknown>): number | undefined {
	let version: number | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== "goal-state") continue;
		version = candidate.data && typeof candidate.data === "object"
			? (candidate.data as { version?: number }).version
			: undefined;
	}
	return version;
}

export default function goalModeExtension(pi: ExtensionAPI): void {
	let goal: GoalState | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | undefined;
	let continueScheduled = false;
	let turnGoalId: string | undefined;
	let turnSignals: ProgressSignals | undefined;

	const currentPlan = (ctx: ExtensionContext): PlanState => reconstructPlanState(ctx.sessionManager.getBranch());
	const currentPlanView = (ctx: ExtensionContext): GoalPlanView | null =>
		goal ? inspectGoalPlan(goal, currentPlan(ctx)) : null;
	const progressSignals = (ctx: ExtensionContext): ProgressSignals => {
		const plan = currentPlan(ctx);
		const fresh = reconstructFreshCheckState(ctx.sessionManager.getBranch());
		return {
			plan: `${plan.goalId ?? ""}:${plan.revision ?? 0}`,
			fresh: `${fresh.revision}:${fresh.changedFiles.join("\0")}:${fresh.lastCheck ?? ""}`,
		};
	};

	const clearContinuation = (): void => {
		if (continuationTimer) clearTimeout(continuationTimer);
		continuationTimer = undefined;
		continueScheduled = false;
	};

	const reconstruct = (ctx: ExtensionContext): void => {
		clearContinuation();
		const branch = ctx.sessionManager.getBranch();
		goal = reconstructGoalState(branch);
		if (goal && latestGoalVersion(branch) !== 2) pi.appendEntry("goal-state", goal);
		refreshStatus(ctx);
	};

	const activateTools = (): void => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const current = pi.getActiveTools();
		const toAdd = ["get_goal", "update_goal", "update_plan"].filter(
			(name) => available.has(name) && !current.includes(name),
		);
		if (toAdd.length > 0) pi.setActiveTools([...current, ...toAdd]);
	};

	pi.on("session_start", (_event, ctx) => {
		reconstruct(ctx);
		activateTools();
		if (goal?.status === "active") {
			armContinuation(ctx, Math.max(0, (goal.nextRunAt ?? Date.now()) - Date.now()));
		}
	});
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", () => clearContinuation());

	registerGoalTools(pi, {
		getGoal: () => goal,
		getPlan: (ctx) => {
			if (!goal) return null;
			return inspectGoalPlan(goal, currentPlan(ctx));
		},
		updateGoal: (status: GoalUpdateStatus, reason: string | undefined, ctx: ExtensionContext) => {
			if (!goal) return null;
			const plan = currentPlanView(ctx);
			if (status === "complete" && plan?.phase !== "complete") {
				return {
					message: "Goal cannot complete until its linked Plan exists and every step is completed.",
					goal,
					isError: true,
				};
			}
			if (status === "blocked" && (!reason?.trim() || plan?.phase !== "user_gate")) {
				return {
					message: "Goal can block only after every unfinished Plan step is waiting with waitKind=user and a concrete reason.",
					goal,
					isError: true,
				};
			}

			clearContinuation();
			goal = {
				...goal,
				status: status === "complete" ? "complete" : "waiting",
				updatedAt: Date.now(),
				nextRunAt: undefined,
				...(status === "blocked" ? { blocker: reason!.trim() } : { blocker: undefined }),
			};
			persist();
			refreshStatus(ctx);
			return {
				message: status === "complete" ? "Goal marked complete." : `Goal waiting for user: ${reason}`,
				goal,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Set or manage a Plan-driven goal: /goal <objective> | /goal | /goal pause|resume|clear",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				if (!goal) {
					ctx.ui.notify("No goal set. Use: /goal <objective>", "info");
					return;
				}
				const plan = currentPlanView(ctx);
				ctx.ui.notify(
					`[${goal.status}] ${goal.objective}\n` +
						`Turns: ${goal.turnsUsed} (no hard limit)\n` +
						`Plan: ${plan?.phase ?? "missing"} ${plan?.done ?? 0}/${plan?.total ?? 0}` +
						(plan?.current ? `\nCurrent: ${plan.current}` : "") +
						(goal.blocker ? `\nWaiting: ${goal.blocker}` : ""),
					"info",
				);
				return;
			}

			if (trimmed === "pause") {
				if (!goal) return void ctx.ui.notify("No goal to pause.", "warning");
				clearContinuation();
				goal = { ...goal, status: "paused", updatedAt: Date.now(), nextRunAt: undefined };
				persist();
				refreshStatus(ctx);
				ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
				return;
			}

			if (trimmed === "resume") {
				if (!goal) return void ctx.ui.notify("No goal to resume.", "warning");
				goal = { ...goal, status: "active", blocker: undefined, noProgressTurns: 0, updatedAt: Date.now() };
				persist();
				refreshStatus(ctx);
				ctx.ui.notify("Goal resumed.", "info");
				armContinuation(ctx, 0);
				return;
			}

			if (trimmed === "clear") {
				clearContinuation();
				goal = null;
				pi.appendEntry("goal-state", null);
				refreshStatus(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}

			setGoal(trimmed, ctx);
		},
	});

	function setGoal(objective: string, ctx: ExtensionContext): void {
		if (!pi.getAllTools().some((tool) => tool.name === "update_plan")) {
			ctx.ui.notify("Goal Mode requires the update_plan extension.", "error");
			return;
		}
		clearContinuation();
		const now = Date.now();
		goal = {
			version: 2,
			id: randomUUID(),
			objective,
			status: "active",
			turnsUsed: 0,
			tokensUsed: 0,
			costUsed: 0,
			noProgressTurns: 0,
			createdAt: now,
			updatedAt: now,
		};
		persist();
		refreshStatus(ctx);
		ctx.ui.notify(`Goal set: ${objective}`, "info");
		if (ctx.mode === "tui" || ctx.mode === "rpc") {
			pi.sendUserMessage(
				`Goal: ${objective}\n\nFirst inspect the current state, then call update_plan with a complete Goal-linked plan. ` +
				"Do not modify files before the Plan has exactly one in_progress step.",
				{ deliverAs: "followUp" },
			);
		}
	}

	pi.on("input", (event, ctx) => {
		if (!goal || event.source === "extension") return;
		clearContinuation();
		if (goal.status === "waiting") {
			goal = {
				...goal,
				status: "active",
				blocker: undefined,
				noProgressTurns: 0,
				updatedAt: Date.now(),
			};
			persist();
			refreshStatus(ctx);
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		continueScheduled = false;
		if (!goal || goal.status !== "active") return;
		if (continuationTimer) clearTimeout(continuationTimer);
		continuationTimer = undefined;
		turnGoalId = goal.id;
		turnSignals = progressSignals(ctx);
		const plan = currentPlan(ctx);
		const view = inspectGoalPlan(goal, plan);
		return {
			message: {
				customType: "goal-context",
				content: renderGoalContext(goal, plan, view),
				display: false,
			},
		};
	});

	pi.on("tool_call", (event, ctx) => {
		if (!goal || goal.status !== "active") return;
		const phase = currentPlanView(ctx)?.phase ?? "planning";
		if (phase === "executing") return;
		if (event.toolName === "bash" && !isSafeCommand(String(event.input.command ?? ""))) {
			return {
				block: true,
				reason: `Goal ${phase}: shell writes and compound commands require an in_progress Plan step.`,
			};
		}
		if (isPlanModeToolAllowed(event.toolName) || ["update_goal", "check_bg", "check_delegate"].includes(event.toolName)) return;
		return {
			block: true,
			reason: `Goal ${phase}: reopen a concrete Plan step as in_progress before using ${event.toolName}.`,
		};
	});

	pi.on("agent_end", (event, ctx) => {
		if (!goal || turnGoalId !== goal.id) return;
		turnGoalId = undefined;
		const usage = readGoalUsage(event.messages);
		goal = {
			...goal,
			turnsUsed: goal.turnsUsed + 1,
			tokensUsed: goal.tokensUsed + usage.tokens,
			costUsed: goal.costUsed + usage.cost,
			updatedAt: Date.now(),
		};
		if (goal.status !== "active") {
			persist();
			refreshStatus(ctx);
			return;
		}
		if (usage.stopReason === "aborted") {
			goal = { ...goal, status: "paused", nextRunAt: undefined };
			persist();
			refreshStatus(ctx);
			ctx.ui.notify("Goal paused after the active turn was aborted.", "warning");
			return;
		}

		const view = currentPlanView(ctx)!;
		if (view.phase === "user_gate") {
			goal = { ...goal, status: "waiting", blocker: view.reason, nextRunAt: undefined };
			persist();
			refreshStatus(ctx);
			ctx.ui.notify(`Goal waiting for user: ${view.reason}`, "warning");
			return;
		}

		const nextSignals = progressSignals(ctx);
		const progressed = !!turnSignals && (turnSignals.plan !== nextSignals.plan || turnSignals.fresh !== nextSignals.fresh);
		const noProgressTurns = progressed ? 0 : goal.noProgressTurns + 1;
		let delay = Math.max(1_000, continuationDelayMs(noProgressTurns));
		if (usage.stopReason === "error") delay = Math.max(delay, 5_000);
		if (view.phase === "waiting" && view.retryAfterSeconds) {
			delay = Math.max(delay, view.retryAfterSeconds * 1_000);
		}
		const nextRunAt = Date.now() + delay;
		goal = { ...goal, noProgressTurns, nextRunAt, updatedAt: Date.now() };
		persist();
		refreshStatus(ctx);
		armContinuation(ctx, delay);
	});

	pi.on("context", (event) => ({
		messages: compactGoalMessages(event.messages, goal?.status === "active"),
	}));

	function armContinuation(ctx: ExtensionContext, delay: number): void {
		if (ctx.mode === "print" || ctx.mode === "json" || !goal || goal.status !== "active" || continueScheduled) return;
		if (continuationTimer) clearTimeout(continuationTimer);
		const goalId = goal.id;
		continuationTimer = setTimeout(() => {
			continuationTimer = undefined;
			if (!goal || goal.id !== goalId || goal.status !== "active" || continueScheduled) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				armContinuation(ctx, 1_000);
				return;
			}
			continueScheduled = true;
			pi.sendMessage(
				{ customType: "goal-continue", content: "Continue from the current Goal Plan frontier.", display: false },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}, Math.max(0, delay));
	}

	function persist(): void {
		if (goal) pi.appendEntry("goal-state", goal);
	}

	function refreshStatus(ctx: ExtensionContext): void {
		if (!goal) return void ctx.ui.setStatus("goal", undefined);
		const view = currentPlanView(ctx);
		const icon = goal.status === "complete" ? "✅" : goal.status === "active" ? "🎯" : goal.status === "waiting" ? "⏳" : "⏸";
		const color = goal.status === "complete" ? "success" : goal.status === "active" ? "accent" : goal.status === "waiting" ? "warning" : "dim";
		const progress = view?.total ? ` ${view.done}/${view.total}` : " plan";
		ctx.ui.setStatus("goal", ctx.ui.theme.fg(color, `${icon}${progress}`));
	}
}

function renderGoalContext(goal: GoalState, plan: PlanState, view: GoalPlanView): string {
	const lines = [
		`[GOAL ACTIVE] ${goal.objective}`,
		`Turn ${goal.turnsUsed + 1}; no hard turn limit; Plan revision ${view.revision}.`,
		`Plan phase: ${view.phase}; progress ${view.done}/${view.total}.`,
	];
	if (view.current) lines.push(`Current executable step: ${view.current}`);
	if (view.waiting.length > 0) {
		lines.push(`Waiting steps: ${view.waiting.map((item) => `${item.step} (${item.waitKind}: ${item.note})`).join("; ")}`);
	}
	if (goal.noProgressTurns > 0) {
		lines.push(`Recovery: ${goal.noProgressTurns} consecutive turn(s) changed neither Plan nor verification state. Re-read evidence and change approach; do not merely restate progress.`);
	}

	if (view.phase === "planning") {
		lines.push("Before making changes, inspect the current state and call update_plan. The linked Plan must have exactly one in_progress step.");
	} else if (view.phase === "invalid") {
		lines.push(`${view.reason} Call update_plan before doing more work.`);
	} else if (view.phase === "executing") {
		lines.push("Work only on the current executable step. Update the Plan when the frontier changes, a step waits, or evidence requires replanning.");
	} else if (view.phase === "waiting") {
		lines.push("Re-check the external or dependency condition once. If unchanged, stay quiet; Goal will back off and retry automatically.");
	} else if (view.phase === "user_gate") {
		lines.push("Use the user's latest reply to update the Plan. Ask only if every unfinished step still requires user input.");
	} else {
		lines.push("All Plan steps are complete. If verification is stale or still required, reopen a verification step before running it; otherwise call update_goal(complete). Reopen the Plan if verification finds more work.");
	}

	// ponytail: cap the injected frontier; add pagination only if real Goal plans regularly exceed this.
	for (const item of plan.plan.slice(0, 20)) {
		const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : item.status === "waiting" ? "~" : " ";
		lines.push(`[${mark}] ${item.step}`);
	}
	return lines.join("\n");
}
