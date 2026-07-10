import { describe, expect, it } from "vitest";
import { isPlanModeToolAllowed, isSafeCommand } from "./index.ts";

describe("plan mode tool policy", () => {
	it("allows read-only tools and plan tracking", () => {
		expect(isPlanModeToolAllowed("read")).toBe(true);
		expect(isPlanModeToolAllowed("bash")).toBe(true);
		expect(isPlanModeToolAllowed("update_plan")).toBe(true);
		expect(isPlanModeToolAllowed("get_goal")).toBe(true);
	});

	it("blocks write-capable and background tools", () => {
		expect(isPlanModeToolAllowed("edit")).toBe(false);
		expect(isPlanModeToolAllowed("write")).toBe(false);
		expect(isPlanModeToolAllowed("hashline_edit")).toBe(false);
		expect(isPlanModeToolAllowed("bash_bg")).toBe(false);
		expect(isPlanModeToolAllowed("subagent")).toBe(false);
	});
});

describe("plan mode bash policy", () => {
	it("allows simple read-only commands", () => {
		expect(isSafeCommand("rg TODO src")).toBe(true);
		expect(isSafeCommand("git diff -- src/foo.ts")).toBe(true);
		expect(isSafeCommand("cat package.json")).toBe(true);
	});

	it("blocks writes, interpreters, networking, and shell composition", () => {
		expect(isSafeCommand("rm -rf dist")).toBe(false);
		expect(isSafeCommand("find . -delete")).toBe(false);
		expect(isSafeCommand("cat file && rm file")).toBe(false);
		expect(isSafeCommand("ls > files.txt")).toBe(false);
		expect(isSafeCommand("python -c 'open(\"x\", \"w\")'")).toBe(false);
		expect(isSafeCommand("curl https://example.com")).toBe(false);
	});
});
