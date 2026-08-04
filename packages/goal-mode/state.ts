import type { PlanItem, PlanState } from "../update-plan/index.ts";

export type GoalStatus = "active" | "paused" | "waiting" | "complete";

export interface GoalState {
	version: 2;
	id: string;
	objective: string;
	status: GoalStatus;
	turnsUsed: number;
	tokensUsed: number;
	costUsed: number;
	noProgressTurns: number;
	createdAt: number;
	updatedAt: number;
	nextRunAt?: number;
	blocker?: string;
}

export type GoalUpdateStatus = "complete" | "blocked";
export type GoalPlanPhase = "planning" | "invalid" | "executing" | "waiting" | "user_gate" | "complete";

export interface GoalPlanView {
	phase: GoalPlanPhase;
	revision: number;
	done: number;
	total: number;
	current?: string;
	waiting: PlanItem[];
	retryAfterSeconds?: number;
	reason?: string;
}

export interface GoalUsage {
	tokens: number;
	cost: number;
	stopReason?: string;
}

const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000];

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeGoalState(value: unknown): GoalState | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	if (typeof input.objective !== "string" || !input.objective.trim()) return null;
	const createdAt = finiteNumber(input.createdAt, Date.now());
	const legacyStatus = String(input.status ?? "active");
	const status: GoalStatus =
		legacyStatus === "complete" ? "complete"
		: legacyStatus === "paused" ? "paused"
		: legacyStatus === "blocked" || legacyStatus === "waiting" ? "waiting"
		: "active";
	return {
		version: 2,
		id: typeof input.id === "string" ? input.id : `legacy-${createdAt.toString(36)}`,
		objective: input.objective,
		status,
		turnsUsed: finiteNumber(input.turnsUsed),
		tokensUsed: finiteNumber(input.tokensUsed),
		costUsed: finiteNumber(input.costUsed),
		noProgressTurns: finiteNumber(input.noProgressTurns),
		createdAt,
		updatedAt: finiteNumber(input.updatedAt, createdAt),
		...(typeof input.nextRunAt === "number" ? { nextRunAt: input.nextRunAt } : {}),
		...(typeof input.blocker === "string" ? { blocker: input.blocker } : {}),
	};
}

export function inspectGoalPlan(goal: GoalState, plan: PlanState): GoalPlanView {
	if (plan.goalId !== goal.id || plan.plan.length === 0) {
		return { phase: "planning", revision: 0, done: 0, total: 0, waiting: [] };
	}
	const done = plan.plan.filter((item) => item.status === "completed").length;
	const active = plan.plan.filter((item) => item.status === "in_progress");
	const pending = plan.plan.filter((item) => item.status === "pending");
	const waiting = plan.plan.filter((item) => item.status === "waiting");
	const base = { revision: plan.revision ?? 0, done, total: plan.plan.length, waiting };

	if (done === plan.plan.length) return { phase: "complete", ...base };
	if (active.length === 1) return { phase: "executing", current: active[0].step, ...base };
	if (active.length > 1 || pending.length > 0) {
		return {
			phase: "invalid",
			reason: "Select exactly one pending step as in_progress before continuing.",
			...base,
		};
	}
	if (waiting.length > 0 && waiting.every((item) => item.waitKind === "user")) {
		return {
			phase: "user_gate",
			reason: waiting.map((item) => item.note).filter(Boolean).join("; "),
			...base,
		};
	}
	const retryAfterSeconds = Math.max(0, ...waiting.map((item) => item.retryAfterSeconds ?? 0)) || undefined;
	return { phase: "waiting", retryAfterSeconds, ...base };
}

export function continuationDelayMs(noProgressTurns: number): number {
	return BACKOFF_MS[Math.min(Math.max(0, Math.floor(noProgressTurns)), BACKOFF_MS.length - 1)];
}

export function readGoalUsage(messages: Iterable<unknown>): GoalUsage {
	let tokens = 0;
	let cost = 0;
	let stopReason: string | undefined;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as {
			role?: string;
			usage?: { totalTokens?: unknown; cost?: { total?: unknown } };
			stopReason?: unknown;
		};
		if (candidate.role !== "assistant") continue;
		tokens += finiteNumber(candidate.usage?.totalTokens);
		cost += finiteNumber(candidate.usage?.cost?.total);
		if (typeof candidate.stopReason === "string") stopReason = candidate.stopReason;
	}
	return { tokens, cost, stopReason };
}

export function compactGoalMessages<T>(messages: readonly T[], active: boolean): T[] {
	let latestContext = -1;
	for (let i = 0; i < messages.length; i += 1) {
		if ((messages[i] as { customType?: string }).customType === "goal-context") latestContext = i;
	}
	return messages.filter((message, index) => {
		const customType = (message as { customType?: string }).customType;
		if (!customType?.startsWith("goal-")) return true;
		return active && customType === "goal-context" && index === latestContext;
	});
}
