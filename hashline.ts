import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Hash ────────────────────────────────────────────────────────────

/** 3-char base36 content hash (46656 possible values). */
export function lineHash(line: string): string {
	const buf = createHash("sha256").update(line).digest();
	const num = (buf[0]! * 65536 + buf[1]! * 256 + buf[2]!) % 46656;
	return num.toString(36).padStart(3, "0").toUpperCase();
}

// ─── Anchor ──────────────────────────────────────────────────────────

export interface Anchor {
	line: number;
	hash: string;
}

export function parseAnchor(anchor: string): Anchor {
	const m = anchor.match(/^(\d+)#([0-9A-Z]+)$/);
	if (!m) {
		throw new Error(
			`Invalid anchor "${anchor}". Expected format: lineNum#HASH (e.g., "11#ABC")`,
		);
	}
	return { line: parseInt(m[1]!, 10), hash: m[2]! };
}

// ─── Read enhancer ───────────────────────────────────────────────────

/** Matches truncation notices that Pi appends to read output. */
const NOTICE_RE = /\n\n\[(Showing lines |\d+ more lines in file|Line \d+ is )/;

/**
 * Add `LINE#HASH| ` prefix to every content line.
 * Truncation notices (appended by Pi's read tool) are preserved without hashes.
 */
export function enhanceWithHashes(text: string, startLine: number): string {
	let content = text;
	let notice = "";
	const m = text.match(NOTICE_RE);
	if (m?.index !== undefined) {
		content = text.slice(0, m.index);
		notice = text.slice(m.index);
	}

	const lines = content.split("\n");
	const enhanced = lines.map((line, i) => {
		const lineNum = startLine + i;
		const hash = lineHash(line);
		return `${lineNum}#${hash}| ${line}`;
	});

	return enhanced.join("\n") + notice;
}

// ─── hashline_edit tool ──────────────────────────────────────────────

interface HashlineEditInput {
	path: string;
	edits: Array<{
		startAnchor: string;
		endAnchor?: string;
		newContent: string;
	}>;
}

export function registerHashlineEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hashline_edit",
		label: "Hashline Edit",
		description:
			'Edit a file using hash-anchored line references. When you read a file, each line is tagged as LINE#HASH| content (e.g., "11#ABC| function hello() {"). Use startAnchor="11#ABC" to reference that line. The hash validates the line hasn\'t changed since you read it — if it has, the edit is rejected and you must re-read. Pass endAnchor for range replacement (inclusive). Multiple edits in one call are applied atomically (all validated before any applied).',
		promptSnippet:
			"Edit files by referencing line#hash anchors from read output (e.g., 11#ABC). Zero stale-line errors.",
		promptGuidelines: [
			'Use hashline_edit instead of edit when the read output shows LINE#HASH| anchors. Parse the anchor from the line tag (e.g., use startAnchor="11#ABC" for line tagged "11#ABC| content"). The hash validates the line hasn\'t changed. If you get a stale-line error, re-read the file and retry.',
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
			edits: Type.Array(
				Type.Object({
					startAnchor: Type.String({
						description: 'Anchor of first line to replace, e.g. "11#ABC"',
					}),
					endAnchor: Type.Optional(
						Type.String({
							description:
								"Anchor of last line to replace (inclusive). Omit for single-line replacement.",
						}),
					),
					newContent: Type.String({
						description: "Replacement content (can be multi-line). Use empty string to delete.",
					}),
				}),
				{
					description:
						"One or more hash-anchored edits. All anchors are validated before any edits are applied (atomic).",
				},
			),
		}),

		async execute(_toolCallId, params: HashlineEditInput, _signal, _onUpdate, ctx) {
			const { resolve } = await import("node:path");
			const { readFile, writeFile } = await import("node:fs/promises");

			const absolutePath = resolve(ctx.cwd, params.path);

			// Read the file
			let content: string;
			try {
				content = await readFile(absolutePath, "utf-8");
			} catch {
				return {
					content: [{ type: "text" as const, text: `Error: Could not read file: ${params.path}` }],
					details: { error: "read_failed", path: absolutePath },
				};
			}

			const lines = content.split("\n");

			// Parse all anchors
			let parsedEdits: Array<{
				start: Anchor;
				end: Anchor;
				newContent: string;
			}>;
			try {
				parsedEdits = params.edits.map((e) => ({
					start: parseAnchor(e.startAnchor),
					end: e.endAnchor ? parseAnchor(e.endAnchor) : parseAnchor(e.startAnchor),
					newContent: e.newContent,
				}));
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { error: "invalid_anchor" },
				};
			}

			// Validate all hashes first (atomic)
			for (const edit of parsedEdits) {
				if (edit.start.line < 1 || edit.start.line > lines.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Line ${edit.start.line} is out of range (file has ${lines.length} lines).`,
							},
						],
						details: {
							error: "out_of_range",
							line: edit.start.line,
							totalLines: lines.length,
						},
					};
				}
				if (edit.end.line < 1 || edit.end.line > lines.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Line ${edit.end.line} is out of range (file has ${lines.length} lines).`,
							},
						],
						details: {
							error: "out_of_range",
							line: edit.end.line,
							totalLines: lines.length,
						},
					};
				}
				if (edit.end.line < edit.start.line) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: End line ${edit.end.line} is before start line ${edit.start.line}.`,
							},
						],
						details: { error: "invalid_range" },
					};
				}

				const startLineContent = lines[edit.start.line - 1]!;
				const endLineContent = lines[edit.end.line - 1]!;
				const startActualHash = lineHash(startLineContent);
				const endActualHash = lineHash(endLineContent);

				if (startActualHash !== edit.start.hash) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Stale line at ${edit.start.line}#${edit.start.hash}. File has changed since last read.\n  Expected hash: ${edit.start.hash}\n  Actual hash:   ${startActualHash}\n  Line content:  ${startLineContent.slice(0, 100)}\n\nRe-read the file and try again.`,
							},
						],
						details: {
							error: "stale_line",
							line: edit.start.line,
							expectedHash: edit.start.hash,
							actualHash: startActualHash,
						},
					};
				}
				if (endActualHash !== edit.end.hash) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Stale line at ${edit.end.line}#${edit.end.hash}. File has changed since last read.\n  Expected hash: ${edit.end.hash}\n  Actual hash:   ${endActualHash}\n\nRe-read the file and try again.`,
							},
						],
						details: {
							error: "stale_line",
							line: edit.end.line,
							expectedHash: edit.end.hash,
							actualHash: endActualHash,
						},
					};
				}
			}

			// Apply edits in reverse order (avoid line-number shifts)
			const newLines = [...lines];
			const results: string[] = [];
			const sortedEdits = [...parsedEdits].sort((a, b) => b.start.line - a.start.line);

			for (const edit of sortedEdits) {
				const newContentLines = edit.newContent.split("\n");
				const replaceCount = edit.end.line - edit.start.line + 1;
				newLines.splice(edit.start.line - 1, replaceCount, ...newContentLines);
				const rangeStr =
					edit.start.line === edit.end.line
						? `line ${edit.start.line}`
						: `lines ${edit.start.line}-${edit.end.line}`;
				results.push(`Replaced ${rangeStr} → ${newContentLines.length} line(s)`);
			}

			// Write the file
			try {
				await writeFile(absolutePath, newLines.join("\n"), "utf-8");
			} catch {
				return {
					content: [
						{ type: "text" as const, text: `Error: Could not write file: ${params.path}` },
					],
					details: { error: "write_failed", path: absolutePath },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Applied ${results.length} edit(s) to ${params.path}:\n${results.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}`,
					},
				],
				details: { editsApplied: results.length, path: absolutePath },
			};
		},
	});
}
