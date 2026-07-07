/**
 * update_plan — Structured task checklist tool
 *
 * Registers an `update_plan` tool the LLM can call to maintain a
 * {step, status} checklist during multi-step work.
 *
 * States: pending → in_progress → completed
 * Constraint: at most one step in_progress at a time.
 *
 * State persists in tool-result details (survives branching) and in
 * a custom session entry (survives resume).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolCall } from "../tool-render.ts";

// ── Types ──────────────────────────────────────────────────────────

type StepStatus = "pending" | "in_progress" | "completed";

interface PlanItem {
	step: string;
	status: StepStatus;
}

interface PlanState {
	plan: PlanItem[];
	explanation?: string;
}

// ── Schema (matches Codex) ─────────────────────────────────────────

const PlanItemSchema = Type.Object(
	{
		step: Type.String({
			description: "One-sentence, outcome-oriented, verifiable step",
		}),
		status: StringEnum(["pending", "in_progress", "completed"] as const),
	},
	{ additionalProperties: false },
);

const UpdatePlanParams = Type.Object(
	{
		plan: Type.Array(PlanItemSchema, {
			description: "Full plan (replaces current). At most one in_progress.",
		}),
		explanation: Type.Optional(
			Type.String({ description: "Why the plan changed (if it did)" }),
		),
	},
	{ additionalProperties: false },
);

// ── Extension ──────────────────────────────────────────────────────

export default function updatePlanExtension(pi: ExtensionAPI): void {
	let state: PlanState = { plan: [] };

	// ── State reconstruction ───────────────────────────────────────
	// Scan session branch for the last update_plan tool result.
	const reconstruct = (ctx: ExtensionContext): void => {
		state = { plan: [] };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "update_plan") continue;
			const d = msg.details as PlanState | undefined;
			if (d?.plan) state = d;
		}
		refreshStatus(ctx);
	};

	const activateTool = (): void => {
		const current = pi.getActiveTools();
		if (!current.includes("update_plan")) {
			pi.setActiveTools([...current, "update_plan"]);
		}
	};

	pi.on("session_start", (_e, ctx) => {
		reconstruct(ctx);
		activateTool();
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// ── Tool registration ─────────────────────────────────────────
	pi.registerTool({
		name: "update_plan",
		label: "Plan",
		description:
			"Update the task plan (checklist). Use for non-trivial multi-step work. " +
			"Pass the FULL plan each call (it replaces the previous). " +
			"Keep exactly one step in_progress until all are completed. " +
			"Good steps are outcome-oriented and verifiable " +
			"(e.g. 'Parse Markdown via CommonMark'). " +
			"Don't pad simple single-step tasks with plan steps.",
		promptSnippet: "update_plan: track a multi-step task checklist (pending/in_progress/completed)",
		promptGuidelines: [
			"Call update_plan for non-trivial multi-step work; skip it for simple single-step tasks",
			"Keep exactly one step in_progress; mark completed steps completed before moving on",
			"If the plan changes, include an explanation",
		],
		parameters: UpdatePlanParams,
		renderCall(args, theme) {
			return renderToolCall(theme, "update_plan", `${args.plan.length} step${args.plan.length === 1 ? "" : "s"}`);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Validate: at most one in_progress
			const inProgress = params.plan.filter((p) => p.status === "in_progress");
			if (inProgress.length > 1) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: at most one step may be in_progress. " +
								`Got ${inProgress.length}. Fix and retry.`,
						},
					],
					details: state,
				};
			}

			state = {
				plan: params.plan,
				explanation: params.explanation,
			};

			// Persist as custom entry (doesn't enter LLM context)
			pi.appendEntry("plan-state", state);
			refreshStatus(ctx);

			const done = state.plan.filter((p) => p.status === "completed").length;
			const total = state.plan.length;
			const allDone = done === total && total > 0;

			return {
				content: [
					{
						type: "text" as const,
						text: allDone
							? `Plan complete! All ${total} steps done.`
							: `Plan updated: ${done}/${total} completed.`,
					},
				],
				details: state,
			};
		},

		renderResult(result, _opts, theme, _ctx) {
			const d = result.details as PlanState | undefined;
			if (!d?.plan?.length) {
				const txt = result.content[0];
				return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
			}

			const lines: string[] = [""];
			const done = d.plan.filter((p) => p.status === "completed").length;
			lines.push(theme.fg("accent", ` Plan ${done}/${d.plan.length} `));
			lines.push("");

			for (const item of d.plan) {
				let mark: string;
				let text: string;
				if (item.status === "completed") {
					mark = theme.fg("success", "✓");
					text = theme.fg("muted", theme.strikethrough(item.step));
				} else if (item.status === "in_progress") {
					mark = theme.fg("warning", "▶");
					text = theme.bold(item.step);
				} else {
					mark = theme.fg("dim", "○");
					text = theme.fg("dim", item.step);
				}
				lines.push(`  ${mark} ${text}`);
			}

			if (d.explanation) {
				lines.push("");
				lines.push(theme.fg("dim", `  ↳ ${d.explanation}`));
			}

			lines.push("");
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Status bar ────────────────────────────────────────────────
	function refreshStatus(ctx: ExtensionContext): void {
		if (!state.plan.length) {
			ctx.ui.setStatus("plan", undefined);
			return;
		}
		const done = state.plan.filter((p) => p.status === "completed").length;
		const total = state.plan.length;
		const allDone = done === total;
		const icon = allDone ? "✓" : "📋";
		ctx.ui.setStatus(
			"plan",
			ctx.ui.theme.fg(allDone ? "success" : "accent", `${icon} ${done}/${total}`),
		);
	}

	// ── /plan-status command ──────────────────────────────────────
	pi.registerCommand("plan-status", {
		description: "Show current plan status",
		handler: async (_args, ctx) => {
			if (!state.plan.length) {
				ctx.ui.notify("No plan yet. Ask the agent to use update_plan.", "info");
				return;
			}
			const text = state.plan
				.map((p) => {
					const m =
						p.status === "completed" ? "✓" : p.status === "in_progress" ? "▶" : "○";
					return `${m} ${p.step}`;
				})
				.join("\n");
			const done = state.plan.filter((p) => p.status === "completed").length;
			ctx.ui.notify(`${done}/${state.plan.length}\n${text}`, "info");
		},
	});
}
