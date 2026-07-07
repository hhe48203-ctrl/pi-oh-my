import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type RenderContent = { readonly type: "text"; readonly text: string } | { readonly type: "image" };

interface RenderableResult {
	readonly content: readonly RenderContent[];
}

interface ResultRenderOptions {
	readonly expanded: boolean;
	readonly fallback?: string;
	readonly maxLength?: number;
}

const DEFAULT_SUMMARY_LENGTH = 140;

export function compactText(text: string, maxLength = DEFAULT_SUMMARY_LENGTH): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function firstText(result: RenderableResult): string {
	for (const part of result.content) {
		if (part.type === "text") return part.text;
	}
	return "";
}

export function renderToolCall(theme: Theme, name: string, detail?: string): Text {
	const suffix = detail ? ` ${theme.fg("toolOutput", compactText(detail))}` : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${suffix}`, 0, 0);
}

export function renderToolResult(theme: Theme, result: RenderableResult, options: ResultRenderOptions): Text {
	const text = firstText(result) || options.fallback || "";
	const display = options.expanded ? text : compactText(text, options.maxLength);
	return new Text(theme.fg("toolOutput", display), 0, 0);
}
