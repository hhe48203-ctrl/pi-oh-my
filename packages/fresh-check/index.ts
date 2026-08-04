import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "fresh-check-state";
const MAX_CHANGED_FILES = 12;

interface PendingCheck {
	command: string;
	revision: number;
}

export interface FreshCheckState {
	revision: number;
	changedFiles: string[];
	pending: Record<string, PendingCheck>;
	lastCheck?: string;
}

export interface ToolObservation {
	toolName: string;
	input: Record<string, unknown>;
	details?: unknown;
	text?: string;
	isError: boolean;
}

export function createFreshCheckState(): FreshCheckState {
	return { revision: 0, changedFiles: [], pending: {} };
}

// ponytail: command-name heuristic; replace with project-configured checks if false positives become common.
export function isVerificationCommand(command: string): boolean {
	return /(?:^|[;&|]\s*)(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)(?::[\w.-]+)?|(?:cargo|go)\s+(?:test|check)|pytest|python\s+-m\s+pytest|vitest|tsc|eslint|ruff|mypy|make\s+(?:test|check|lint|build))(?:\s|$)/i.test(command) ||
		/(?:^|[;&|]\s*)bun\s+(?:run\s+)?(?:\S+\/)?(?:test[-_.]\S+|\S+\.(?:test|spec)\.\S+)(?:\s|$)/i.test(command);
}

function writableSubagent(input: Record<string, unknown>): boolean {
	if (typeof input.tools !== "string") return false;
	return input.tools.split(",").some((tool) => ["bash", "edit", "write"].includes(tool.trim()));
}

function mutationLabel(observation: ToolObservation): string | undefined {
	if (["edit", "write", "hashline_edit"].includes(observation.toolName)) {
		return typeof observation.input.path === "string" ? observation.input.path : observation.toolName;
	}
	if (["subagent", "subagent_async", "background_delegate"].includes(observation.toolName) && writableSubagent(observation.input)) {
		return typeof observation.input.description === "string"
			? `subagent: ${observation.input.description}`
			: "writable subagent";
	}
	return undefined;
}

function backgroundTaskId(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const taskId = (details as { taskId?: unknown }).taskId;
	return typeof taskId === "string" ? taskId : undefined;
}

export function observeToolResult(state: FreshCheckState, observation: ToolObservation): FreshCheckState {
	const changed = mutationLabel(observation);
	const writableAgent = ["subagent", "subagent_async", "background_delegate"].includes(observation.toolName);
	if (changed && (!observation.isError || writableAgent)) {
		return {
			...state,
			revision: state.revision + 1,
			changedFiles: [...state.changedFiles.filter((path) => path !== changed), changed].slice(-MAX_CHANGED_FILES),
		};
	}
	if (observation.isError) return state;

	if (
		observation.toolName === "bash" &&
		typeof observation.input.command === "string" &&
		isVerificationCommand(observation.input.command)
	) {
		if (state.changedFiles.length === 0) return state;
		return { ...state, changedFiles: [], pending: {}, lastCheck: observation.input.command };
	}

	if (
		observation.toolName === "bash_bg" &&
		typeof observation.input.command === "string" &&
		isVerificationCommand(observation.input.command)
	) {
		const taskId = backgroundTaskId(observation.details);
		if (!taskId || state.changedFiles.length === 0) return state;
		return {
			...state,
			pending: { ...state.pending, [taskId]: { command: observation.input.command, revision: state.revision } },
		};
	}

	if (observation.toolName === "check_bg" && typeof observation.input.task_id === "string") {
		const taskId = observation.input.task_id;
		const check = state.pending[taskId];
		if (
			!check ||
			!observation.text ||
			!/Status: (?:completed|failed|timed out)/.test(observation.text)
		) return state;
		const pending = { ...state.pending };
		delete pending[taskId];
		if (observation.text.includes("Status: completed") && check.revision === state.revision) {
			return { ...state, changedFiles: [], pending, lastCheck: check.command };
		}
		return { ...state, pending };
	}

	return state;
}

function parseState(value: unknown): FreshCheckState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<FreshCheckState>;
	if (typeof state.revision !== "number" || !Number.isInteger(state.revision)) return undefined;
	if (!Array.isArray(state.changedFiles) || !state.changedFiles.every((path) => typeof path === "string")) return undefined;
	const pending: Record<string, PendingCheck> = {};
	if (state.pending && typeof state.pending === "object") {
		for (const [taskId, check] of Object.entries(state.pending)) {
			if (typeof check?.command === "string" && Number.isInteger(check.revision)) pending[taskId] = check;
		}
	}
	return {
		revision: state.revision,
		changedFiles: state.changedFiles.slice(-MAX_CHANGED_FILES),
		pending,
		...(typeof state.lastCheck === "string" ? { lastCheck: state.lastCheck } : {}),
	};
}

export function reconstructFreshCheckState(entries: readonly SessionEntry[]): FreshCheckState {
	let state = createFreshCheckState();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		state = parseState(entry.data) ?? state;
	}
	return state;
}

export default function freshCheck(pi: ExtensionAPI): void {
	let state = createFreshCheckState();

	const refreshStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("fresh-check", state.changedFiles.length > 0 ? `verify ${state.changedFiles.length}` : undefined);
	};

	const reconstruct = (ctx: ExtensionContext) => {
		state = reconstructFreshCheckState(ctx.sessionManager.getBranch());
		refreshStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

	pi.on("tool_result", (event, ctx) => {
		const wasClean = state.changedFiles.length === 0;
		const next = observeToolResult(state, {
			toolName: event.toolName,
			input: event.input,
			details: event.details,
			text: event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
			isError: event.isError,
		});
		if (next === state) return;
		state = next;
		pi.appendEntry(STATE_TYPE, state);
		refreshStatus(ctx);
		if (wasClean && state.changedFiles.length > 0) {
			return {
				content: [
					...event.content,
					{ type: "text" as const, text: "Fresh-check: run a relevant test or check after the final change before completion." },
				],
			};
		}
	});

	pi.on("tool_call", (event) => {
		if (
			event.toolName !== "update_goal" ||
			event.input.status !== "complete" ||
			state.changedFiles.length === 0
		) return;
		return {
			block: true,
			reason: `Fresh-check: verification is older than the latest change (${state.changedFiles.join(", ")}). Run a relevant test or check first.`,
		};
	});

	pi.on("before_agent_start", () => {
		if (state.changedFiles.length === 0) return;
		return {
			message: {
				customType: "fresh-check-reminder",
				content: `Verification pending after changes to: ${state.changedFiles.join(", ")}. Run a relevant test or check before claiming completion.`,
				display: false,
			},
		};
	});

	pi.registerCommand("fresh-check", {
		description: "Show whether verification is newer than the latest change",
		handler: async (_args, ctx) => {
			if (state.changedFiles.length > 0) {
				const pending = Object.keys(state.pending).length;
				const suffix = pending
					? ` (${pending} background check${pending === 1 ? "" : "s"} running)`
					: "";
				ctx.ui.notify(`Verification pending for: ${state.changedFiles.join(", ")}${suffix}`, "warning");
				return;
			}
			ctx.ui.notify(state.lastCheck ? `Fresh: ${state.lastCheck}` : "No changes tracked in this session.", "info");
		},
	});
}
