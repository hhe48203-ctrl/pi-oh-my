import { describe, expect, it } from "vitest";
import { reconstructPlanState } from "./index.ts";

describe("reconstructPlanState", () => {
	it("restores the newest durable custom state after tool results are compacted", () => {
		const toolState = { plan: [{ step: "Inspect", status: "in_progress" as const }] };
		const persistedState = {
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
