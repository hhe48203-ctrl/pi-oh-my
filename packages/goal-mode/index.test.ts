import { describe, expect, it } from "vitest";
import { reconstructGoalState } from "./index.ts";

const activeGoal = {
	objective: "Ship the fix",
	status: "active" as const,
	turnsUsed: 2,
	maxTurns: 40,
	tokensUsed: 123,
	createdAt: 1,
};

describe("reconstructGoalState", () => {
	it("uses the latest goal-state entry", () => {
		const completedGoal = { ...activeGoal, status: "complete" as const };
		expect(reconstructGoalState([
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{ type: "custom", customType: "goal-state", data: completedGoal },
		])).toEqual(completedGoal);
	});

	it("keeps a cleared goal cleared after session reconstruction", () => {
		expect(reconstructGoalState([
			{ type: "custom", customType: "goal-state", data: activeGoal },
			{ type: "custom", customType: "goal-state", data: null },
		])).toBeNull();
	});
});
