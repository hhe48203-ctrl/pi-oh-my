import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderToolCall, renderToolResult } from "../tool-render.ts";
import type { GoalState, GoalUpdateStatus } from "./state.ts";

interface GoalUpdateResult {
	message: string;
	goal: GoalState;
}

interface GoalToolRuntime {
	getGoal(): GoalState | null;
	updateGoal(status: GoalUpdateStatus, reason: string | undefined, ctx: ExtensionContext): GoalUpdateResult | null;
}

const UpdateGoalParams = Type.Object(
	{
		status: StringEnum(["complete", "blocked"] as const),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const GetGoalParams = Type.Object({}, { additionalProperties: false });

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalToolRuntime): void {
	pi.registerTool({
		name: "get_goal",
		label: "Goal",
		description:
			"Read the current active goal, its status, and remaining turn budget. " +
			"Use this to remind yourself of the objective and how many turns you have left.",
		parameters: GetGoalParams,
		renderCall(_args, theme) {
			return renderToolCall(theme, "get_goal");
		},
		renderResult(result, options, theme) {
			return renderToolResult(theme, result, { expanded: options.expanded });
		},

		async execute() {
			const goal = runtime.getGoal();
			if (!goal) {
				return {
					content: [{ type: "text" as const, text: "No active goal." }],
					details: null,
				};
			}
			const remaining = goal.maxTurns - goal.turnsUsed;
			const text =
				`Goal: ${goal.objective}\n` +
				`Status: ${goal.status}\n` +
				`Turns: ${goal.turnsUsed}/${goal.maxTurns} (${remaining} remaining)\n` +
				`Tokens: ~${goal.tokensUsed}`;
			return {
				content: [{ type: "text" as const, text }],
				details: goal,
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Mark the active goal as complete or blocked. " +
			"Use 'complete' ONLY when you have verified the objective is met " +
			"(tests pass, files exist, etc). " +
			"Use 'blocked' when you cannot proceed and need user help. " +
			"You CANNOT pause, resume, or clear — those are user-controlled.",
		promptSnippet: "update_goal: mark the goal complete or blocked",
		promptGuidelines: [
			"Call update_goal(complete) when the objective is verifiably met",
			"Call update_goal(blocked) when you cannot proceed",
		],
		parameters: UpdateGoalParams,
		renderCall(args, theme) {
			return renderToolCall(theme, "update_goal", args.reason ? `${args.status}: ${args.reason}` : args.status);
		},
		renderResult(result, options, theme) {
			return renderToolResult(theme, result, { expanded: options.expanded });
		},

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = runtime.updateGoal(params.status, params.reason, ctx);
			if (!result) {
				return {
					content: [{ type: "text" as const, text: "No active goal." }],
					details: null,
				};
			}

			ctx.ui.notify(result.message, params.status === "complete" ? "info" : "warning");
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: result.goal,
			};
		},
	});
}
