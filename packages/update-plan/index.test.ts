import { describe, expect, it } from "vitest";
import updatePlan, { activeGoalId, reconstructPlanState, validatePlan } from "./index.ts";

describe("reconstructPlanState", () => {
	it("restores the newest durable goal-linked state", () => {
		const toolState = { plan: [{ step: "Inspect", status: "in_progress" as const }] };
		const persistedState = {
			goalId: "goal-1",
			revision: 2,
			plan: [
				{ step: "Inspect", status: "completed" as const },
				{ step: "Implement", status: "in_progress" as const },
			],
			explanation: "Recovered after compaction",
		};

		expect(reconstructPlanState([
			{ type: "message", message: { role: "toolResult", toolName: "update_plan", details: toolState } },
			{ type: "custom", customType: "plan-state", data: persistedState },
		])).toEqual(persistedState);
	});

	it("ignores unrelated or malformed session entries", () => {
		expect(reconstructPlanState([
			null,
			{ type: "custom", customType: "other", data: { plan: [{ step: "Wrong", status: "completed" }] } },
			{ type: "custom", customType: "plan-state", data: {} },
		])).toEqual({ plan: [] });
	});
});

describe("Goal-linked Plan rules", () => {
	it("finds only the latest active v2 Goal", () => {
		expect(activeGoalId([
			{ type: "custom", customType: "goal-state", data: { id: "one", status: "complete" } },
			{ type: "custom", customType: "goal-state", data: { id: "two", status: "active" } },
		])).toBe("two");
		expect(activeGoalId([
			{ type: "custom", customType: "goal-state", data: { id: "two", status: "active" } },
			{ type: "custom", customType: "goal-state", data: null },
		])).toBeUndefined();
	});

	it("requires one active step while executable work remains", () => {
		expect(validatePlan([{ step: "Implement", status: "pending" }], "goal-1")).toContain("exactly one");
		expect(validatePlan([{ step: "Implement", status: "in_progress" }], "goal-1")).toBeUndefined();
		expect(validatePlan([{ step: "Done", status: "completed" }], "goal-1")).toBeUndefined();
	});

	it("requires typed waiting metadata", () => {
		expect(validatePlan([{ step: "Wait", status: "waiting" }], "goal-1")).toContain("requires waitKind and note");
		expect(validatePlan([
			{ step: "Wait", status: "waiting", waitKind: "external", note: "CI pending", retryAfterSeconds: 30 },
		], "goal-1")).toBeUndefined();
		expect(validatePlan([
			{ step: "Work", status: "in_progress", waitKind: "external", note: "wrong" },
		], "goal-1")).toContain("only while waiting");
	});

	it("allows a standalone plan without an active step", () => {
		expect(validatePlan([{ step: "Maybe later", status: "pending" }])).toBeUndefined();
		expect(validatePlan([{ step: "Wait", status: "waiting" }])).toContain("requires waitKind and note");
	});

	it("automatically binds persisted updates to the active Goal", async () => {
		const branch: any[] = [{ type: "custom", customType: "goal-state", data: { id: "goal-1", status: "active" } }];
		const tools: Record<string, any> = {};
		updatePlan({
			on() {},
			registerTool(tool: any) { tools[tool.name] = tool; },
			registerCommand() {},
			getActiveTools: () => ["update_plan"],
			setActiveTools() {},
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		} as any);
		const ctx = {
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
		};

		const result = await tools.update_plan.execute("call", {
			plan: [{ step: "Implement", status: "in_progress" }],
		}, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ goalId: "goal-1", revision: 1 });
		expect(branch.at(-1).data).toMatchObject({ goalId: "goal-1", revision: 1 });
	});
});
