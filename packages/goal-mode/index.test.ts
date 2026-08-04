import { afterEach, describe, expect, it, vi } from "vitest";

import {
	compactGoalMessages,
	continuationDelayMs,
	inspectGoalPlan,
	readGoalUsage,
	type GoalState,
} from "./state.ts";
import goalMode, { reconstructGoalState } from "./index.ts";

const activeGoal: GoalState = {
	version: 2,
	id: "goal-1",
	objective: "Ship the fix",
	status: "active",
	turnsUsed: 2,
	tokensUsed: 123,
	costUsed: 0.25,
	noProgressTurns: 0,
	createdAt: 1,
	updatedAt: 2,
};

describe("Goal state", () => {
	it("uses the latest state and migrates legacy budgets without enforcing them", () => {
		expect(reconstructGoalState([
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{
				type: "custom",
				customType: "goal-state",
				data: { objective: "Legacy", status: "blocked", turnsUsed: 40, maxTurns: 40, tokensUsed: 500, createdAt: 3 },
			},
		])).toEqual({
			version: 2,
			id: "legacy-3",
			objective: "Legacy",
			status: "waiting",
			turnsUsed: 40,
			tokensUsed: 500,
			costUsed: 0,
			noProgressTurns: 0,
			createdAt: 3,
			updatedAt: 3,
		});
	});

	it("keeps a cleared goal cleared after reconstruction", () => {
		expect(reconstructGoalState([
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{ type: "custom", customType: "goal-state", data: null },
		])).toBeNull();
	});
});

describe("Goal Plan frontier", () => {
	it("requires a matching plan and exposes its active step", () => {
		expect(inspectGoalPlan(activeGoal, { plan: [] }).phase).toBe("planning");
		expect(inspectGoalPlan(activeGoal, {
			goalId: activeGoal.id,
			revision: 2,
			plan: [
				{ step: "Inspect", status: "completed" },
				{ step: "Implement", status: "in_progress" },
			],
		})).toMatchObject({ phase: "executing", revision: 2, current: "Implement", done: 1, total: 2 });
	});

	it("distinguishes automatic waits from true user gates", () => {
		const external = inspectGoalPlan(activeGoal, {
			goalId: activeGoal.id,
			plan: [{ step: "Wait for CI", status: "waiting", waitKind: "external", note: "CI pending", retryAfterSeconds: 30 }],
		});
		expect(external).toMatchObject({ phase: "waiting", retryAfterSeconds: 30 });

		const user = inspectGoalPlan(activeGoal, {
			goalId: activeGoal.id,
			plan: [{ step: "Choose API", status: "waiting", waitKind: "user", note: "Choose v1 or v2" }],
		});
		expect(user).toMatchObject({ phase: "user_gate", reason: "Choose v1 or v2" });
	});

	it("requires pending work to select one executable step", () => {
		expect(inspectGoalPlan(activeGoal, {
			goalId: activeGoal.id,
			plan: [{ step: "Implement", status: "pending" }],
		}).phase).toBe("invalid");
	});
});

describe("Goal continuation", () => {
	it("backs off without imposing a total turn limit", () => {
		expect([0, 1, 2, 3, 4, 100].map(continuationDelayMs)).toEqual([0, 5_000, 30_000, 120_000, 600_000, 600_000]);
	});

	it("accumulates actual assistant usage", () => {
		expect(readGoalUsage([
			{ role: "assistant", usage: { totalTokens: 10, cost: { total: 0.1 } }, stopReason: "toolUse" },
			{ role: "toolResult" },
			{ role: "assistant", usage: { totalTokens: 20, cost: { total: 0.2 } }, stopReason: "stop" },
		])).toEqual({ tokens: 30, cost: 0.30000000000000004, stopReason: "stop" });
	});

	it("keeps only the latest active context and removes continuation noise", () => {
		const messages = [
			{ customType: "goal-context", value: 1 },
			{ customType: "goal-continue" },
			{ customType: "other" },
			{ customType: "goal-context", value: 2 },
		];
		expect(compactGoalMessages(messages, true)).toEqual([messages[2], messages[3]]);
		expect(compactGoalMessages(messages, false)).toEqual([messages[2]]);
	});
});

describe("Goal extension integration", () => {
	afterEach(() => vi.useRealTimers());

	function harness(branch: any[]) {
		const handlers: Record<string, Function> = {};
		const tools: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const notify = vi.fn();
		const api: any = {
			on(event: string, handler: Function) { handlers[event] = handler; },
			registerTool(tool: any) { tools[tool.name] = tool; },
			registerCommand(name: string, command: any) { commands[name] = command; },
			getAllTools: () => [{ name: "update_plan" }, ...Object.values(tools)],
			getActiveTools: () => ["read", "bash", "edit", "write", "update_plan"],
			setActiveTools() {},
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			sendUserMessage: vi.fn(),
			sendMessage: vi.fn(),
		};
		const ctx: any = {
			mode: "tui",
			sessionManager: { getBranch: () => branch },
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				notify,
				setStatus() {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		goalMode(api);
		return { api, commands, ctx, handlers, notify, tools };
	}

	it("does not start an unawaited turn from a single-shot command", async () => {
		vi.useFakeTimers();
		const branch: any[] = [];
		const { api, commands, ctx, handlers } = harness(branch);
		ctx.mode = "print";
		await commands.goal.handler("Inspect the repository", ctx);
		handlers.session_start!({}, ctx);
		vi.advanceTimersByTime(0);
		expect(branch.at(-1).data.status).toBe("active");
		expect(api.sendUserMessage).not.toHaveBeenCalled();
		expect(api.sendMessage).not.toHaveBeenCalled();
	});

	it("blocks writes before planning and rejects completion until the linked Plan closes", async () => {
		vi.useFakeTimers();
		const branch: any[] = [];
		const { api, commands, ctx, handlers, tools } = harness(branch);
		await commands.goal.handler("Ship the fix", ctx);
		const goal = branch.at(-1).data as GoalState;

		expect(handlers.tool_call!({ toolName: "write", input: { path: "a.ts" } }, ctx)).toMatchObject({ block: true });
		expect(handlers.tool_call!({ toolName: "bash", input: { command: "printf x > a.ts" } }, ctx)).toMatchObject({ block: true });
		expect(handlers.tool_call!({ toolName: "bash", input: { command: "git status" } }, ctx)).toBeUndefined();
		branch.push({
			type: "custom",
			customType: "plan-state",
			data: { goalId: goal.id, revision: 1, plan: [{ step: "Implement", status: "in_progress" }] },
		});
		expect(handlers.tool_call!({ toolName: "write", input: { path: "a.ts" } }, ctx)).toBeUndefined();

		const early = await tools.update_goal.execute("call", { status: "complete" }, undefined, undefined, ctx);
		expect(early.isError).toBe(true);
		branch.push({
			type: "custom",
			customType: "plan-state",
			data: { goalId: goal.id, revision: 2, plan: [{ step: "Implement", status: "completed" }] },
		});
		expect(handlers.tool_call!({ toolName: "bash", input: { command: "printf x > a.ts" } }, ctx)).toMatchObject({ block: true });
		expect(handlers.tool_call!({ toolName: "bash", input: { command: "git status" } }, ctx)).toBeUndefined();
		expect(handlers.tool_call!({ toolName: "bash_bg", input: { command: "printf x > a.ts" } }, ctx)).toMatchObject({ block: true });
		expect(handlers.tool_call!({ toolName: "check_bg", input: { task_id: "check-1" } }, ctx)).toBeUndefined();
		expect(handlers.tool_call!({ toolName: "update_goal", input: { status: "complete" } }, ctx)).toBeUndefined();
		const complete = await tools.update_goal.execute("call", { status: "complete" }, undefined, undefined, ctx);
		expect(complete.terminate).toBe(true);
		expect(branch.at(-1).data.status).toBe("complete");
		handlers.session_shutdown!({}, ctx);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resumes active sessions and backs off after a no-progress turn", () => {
		vi.useFakeTimers();
		const branch: any[] = [
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{
				type: "custom",
				customType: "plan-state",
				data: { goalId: activeGoal.id, revision: 1, plan: [{ step: "Implement", status: "in_progress" }] },
			},
		];
		const { api, ctx, handlers } = harness(branch);
		handlers.session_start!({}, ctx);
		vi.advanceTimersByTime(0);
		expect(api.sendMessage).toHaveBeenCalledTimes(1);

		handlers.before_agent_start!({}, ctx);
		const endedAt = Date.now();
		handlers.agent_end!({
			messages: [{ role: "assistant", usage: { totalTokens: 10, cost: { total: 0.01 } }, stopReason: "stop" }],
		}, ctx);
		const next = branch.at(-1).data as GoalState;
		expect(next.noProgressTurns).toBe(1);
		expect(next.nextRunAt).toBeGreaterThanOrEqual(endedAt + 5_000);
		vi.advanceTimersByTime(4_999);
		expect(api.sendMessage).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(api.sendMessage).toHaveBeenCalledTimes(2);
		handlers.session_shutdown!({}, ctx);
	});

	it("throttles automatic continuation even when a turn makes progress", () => {
		vi.useFakeTimers();
		const branch: any[] = [
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{
				type: "custom",
				customType: "plan-state",
				data: { goalId: activeGoal.id, revision: 1, plan: [{ step: "Implement", status: "in_progress" }] },
			},
		];
		const { api, ctx, handlers } = harness(branch);
		handlers.session_start!({}, ctx);
		vi.advanceTimersByTime(0);
		handlers.before_agent_start!({}, ctx);
		branch.push({
			type: "custom",
			customType: "plan-state",
			data: { goalId: activeGoal.id, revision: 2, plan: [{ step: "Implement", status: "completed" }] },
		});
		handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		vi.advanceTimersByTime(999);
		expect(api.sendMessage).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(api.sendMessage).toHaveBeenCalledTimes(2);
		handlers.session_shutdown!({}, ctx);
	});
});
