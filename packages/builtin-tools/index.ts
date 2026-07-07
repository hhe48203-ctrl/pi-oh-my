import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { compactText, firstText } from "../tool-render.ts";

const MAX_DETAIL = 80;
const MAX_EXPANDED = 4_000;

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
	};
}

type BuiltInTools = ReturnType<typeof createBuiltInTools>;

const toolCache = new Map<string, BuiltInTools>();

function getBuiltInTools(cwd: string): BuiltInTools {
	const cached = toolCache.get(cwd);
	if (cached) return cached;
	const tools = createBuiltInTools(cwd);
	toolCache.set(cwd, tools);
	return tools;
}

function lineCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split("\n").filter((line) => line.trim().length > 0).length;
}

function text(theme: Theme, value: string): Text {
	return new Text(theme.fg("toolOutput", value), 0, 0);
}

function summary(theme: Theme, output: string, noun: string, expanded: boolean): Text {
	if (expanded) return text(theme, output.length > MAX_EXPANDED ? `${output.slice(0, MAX_EXPANDED - 3)}...` : output);
	const count = lineCount(output);
	return text(theme, plural(count, noun));
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function call(theme: Theme, name: string, detail: string): Text {
	const body = detail ? ` ${theme.fg("toolOutput", compactText(detail, MAX_DETAIL))}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${body}`, 0, 0);
}

export function registerBuiltInToolCards(pi: Pick<ExtensionAPI, "registerTool">): void {
	pi.registerTool({
		...getBuiltInTools(process.cwd()).read,
		name: "read",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const range = args.offset || args.limit ? `:${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}` : "";
			return call(theme, "read", `${args.path}${range}`);
		},
		renderResult(result, { expanded }, theme) {
			const output = firstText(result);
			return summary(theme, output, "line", expanded);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).bash,
		name: "bash",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return call(theme, "bash", args.command);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return text(theme, "running");
			const output = firstText(result);
			return summary(theme, output, "line", expanded);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).edit,
		name: "edit",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return call(theme, "edit", `${args.path} (${args.edits.length} edit${args.edits.length === 1 ? "" : "s"})`);
		},
		renderResult(result, { expanded }, theme, context) {
			const output = firstText(result);
			if (expanded && output) return text(theme, output.length > MAX_EXPANDED ? `${output.slice(0, MAX_EXPANDED - 3)}...` : output);
			return text(theme, context.isError ? "edit failed" : "applied");
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).write,
		name: "write",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return call(theme, "write", `${args.path} (${plural(lineCount(args.content), "line")})`);
		},
		renderResult(result, { expanded }, theme, context) {
			const output = firstText(result);
			if (expanded && output) return text(theme, output.length > MAX_EXPANDED ? `${output.slice(0, MAX_EXPANDED - 3)}...` : output);
			return text(theme, context.isError ? "write failed" : "written");
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).find,
		name: "find",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return call(theme, "find", `${args.pattern} in ${args.path ?? "."}`);
		},
		renderResult(result, { expanded }, theme) {
			return summary(theme, firstText(result), "file", expanded);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).grep,
		name: "grep",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const flags = [args.glob, args.ignoreCase ? "ignore-case" : "", args.literal ? "literal" : ""].filter(Boolean).join(", ");
			return call(theme, "grep", `${args.pattern} in ${args.path ?? "."}${flags ? ` (${flags})` : ""}`);
		},
		renderResult(result, { expanded }, theme) {
			return summary(theme, firstText(result), "match", expanded);
		},
	});

	pi.registerTool({
		...getBuiltInTools(process.cwd()).ls,
		name: "ls",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return call(theme, "ls", args.path ?? ".");
		},
		renderResult(result, { expanded }, theme) {
			return summary(theme, firstText(result), "entry", expanded);
		},
	});
}
