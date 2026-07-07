import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBuiltInToolCards } from "./index.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

describe("registerBuiltInToolCards", () => {
	it("registers compact renderers for every built-in tool", () => {
		const tools: RegisteredTool[] = [];
		const pi: Pick<ExtensionAPI, "registerTool"> = {
			registerTool(tool: RegisteredTool): void {
				tools.push(tool);
			},
		};
		const theme = {
			bold: (s: string) => s,
			fg: (_color: string, s: string) => s,
		};

		registerBuiltInToolCards(pi);

		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "find", "grep", "ls"]);
		for (const tool of tools) {
			expect(tool.renderCall).toBeTypeOf("function");
			expect(tool.renderResult).toBeTypeOf("function");
		}

		const samples = new Map<string, string>([
			["read", tools.find((tool) => tool.name === "read")?.renderCall?.({ path: "README.md" }, theme)?.text ?? ""],
			["bash", tools.find((tool) => tool.name === "bash")?.renderCall?.({ command: "bun test" }, theme)?.text ?? ""],
			["edit", tools.find((tool) => tool.name === "edit")?.renderCall?.({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, theme)?.text ?? ""],
			["write", tools.find((tool) => tool.name === "write")?.renderCall?.({ path: "a.ts", content: "one\ntwo" }, theme)?.text ?? ""],
			["find", tools.find((tool) => tool.name === "find")?.renderCall?.({ pattern: "*.ts", path: "src" }, theme)?.text ?? ""],
			["grep", tools.find((tool) => tool.name === "grep")?.renderCall?.({ pattern: "needle", path: "src" }, theme)?.text ?? ""],
			["ls", tools.find((tool) => tool.name === "ls")?.renderCall?.({ path: "src" }, theme)?.text ?? ""],
		]);

		expect(samples.get("read")).toBe("read README.md");
		expect(samples.get("bash")).toBe("bash bun test");
		expect(samples.get("edit")).toBe("edit a.ts (1 edit)");
		expect(samples.get("write")).toBe("write a.ts (2 lines)");
		expect(samples.get("find")).toBe("find *.ts in src");
		expect(samples.get("grep")).toBe("grep needle in src");
		expect(samples.get("ls")).toBe("ls src");
		for (const value of samples.values()) {
			expect(value).not.toContain("{");
			expect(value).not.toContain("\"");
		}
	});

	it("overrides grep rendering without raw JSON", () => {
		const tools: RegisteredTool[] = [];
		const pi: Pick<ExtensionAPI, "registerTool"> = {
			registerTool(tool: RegisteredTool): void {
				tools.push(tool);
			},
		};
		const theme = {
			bold: (s: string) => s,
			fg: (_color: string, s: string) => s,
		};

		registerBuiltInToolCards(pi);

		const grep = tools.find((tool) => tool.name === "grep");
		const call = grep?.renderCall?.({ pattern: "Model Context Protocol", path: "docs", literal: true }, theme)?.text ?? "";
		const result = grep?.renderResult?.(
			{ content: [{ type: "text", text: "docs/a.md:1:Model Context Protocol" }] },
			{ expanded: false, isPartial: false },
			theme,
		)?.text ?? "";

		expect(call).toBe("grep Model Context Protocol in docs (literal)");
		expect(result).toBe("1 match");
		expect(call).not.toContain("{");
		expect(result).not.toContain("{");
	});

	it("keeps write success results clear when the built-in tool returns text", () => {
		const tools: RegisteredTool[] = [];
		const pi: Pick<ExtensionAPI, "registerTool"> = {
			registerTool(tool: RegisteredTool): void {
				tools.push(tool);
			},
		};
		const theme = {
			bold: (s: string) => s,
			fg: (_color: string, s: string) => s,
		};

		registerBuiltInToolCards(pi);

		const write = tools.find((tool) => tool.name === "write");
		const result = write?.renderResult?.(
			{ content: [{ type: "text", text: "Successfully wrote 12 bytes to a.ts" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false },
		)?.text ?? "";

		expect(result).toBe("written");
	});
});
