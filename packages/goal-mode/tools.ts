import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderToolCall, renderToolResult } from "../tool-render.ts";
import type { GoalPlanView, GoalState, GoalUpdateStatus } from "./state.ts";

interface GoalUpdateResult {
	message: string;
	goal: GoalState;
	isError?: boolean;
}

interface GoalToolRuntime {
	getGoal(): GoalState | null;
	getPlan(ctx: ExtensionContext): GoalPlanView | null;
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
			"Read the current Goal, its linked Plan frontier, accumulated usage, and continuation state.",
		parameters: GetGoalParams,
		renderCall(_args, theme) {
			return renderToolCall(theme, "get_goal");
		},
		renderResult(result, options, theme) {
			return renderToolResult(theme, result, { expanded: options.expanded });
		},

		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const goal = runtime.getGoal();
			const plan = runtime.getPlan(ctx);
			if (!goal) {
				return {
					content: [{ type: "text" as const, text: "No active goal." }],
					details: null,
				};
			}
			const text =
				`Goal: ${goal.objective}\n` +
				`Status: ${goal.status}\n` +
				`Turns: ${goal.turnsUsed} (no hard limit)\n` +
				`Tokens: ${goal.tokensUsed}\n` +
				`Cost: $${goal.costUsed.toFixed(4)}\n` +
				`Plan: ${plan ? `${plan.phase}, ${plan.done}/${plan.total}, revision ${plan.revision}` : "unavailable"}` +
				(plan?.current ? `\nCurrent step: ${plan.current}` : "") +
				(goal.blocker ? `\nWaiting for user: ${goal.blocker}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: { goal, plan },
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Mark the active Goal complete after every linked Plan step is completed, " +
			"or blocked only after every unfinished Plan step is waiting for user input. " +
			"You CANNOT pause, resume, or clear — those are user-controlled.",
		promptSnippet: "update_goal: mark the goal complete or blocked",
		promptGuidelines: [
			"Call update_goal(complete) only after the linked Plan is complete and required verification passes.",
			"Before update_goal(blocked), mark every unfinished Plan step waiting with waitKind=user and a concrete note.",
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

			if (!result.isError) ctx.ui.notify(result.message, params.status === "complete" ? "info" : "warning");
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: result.goal,
				...(result.isError ? { isError: true } : { terminate: true }),
			};
		},
	});
}
