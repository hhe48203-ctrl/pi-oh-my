import { describe, expect, it } from "vitest";
import { compactText, firstText } from "./tool-render.ts";

describe("compactText", () => {
	it("collapses whitespace and truncates long text", () => {
		const text = "first line\nsecond line\tthird line";
		expect(compactText(text, 18)).toBe("first line seco...");
	});

	it("keeps short text unchanged after whitespace cleanup", () => {
		expect(compactText("  ready\nnow  ")).toBe("ready now");
	});
});

describe("firstText", () => {
	it("returns the first text content block", () => {
		const result = {
			content: [
				{ type: "image" as const },
				{ type: "text" as const, text: "hello" },
			],
		};

		expect(firstText(result)).toBe("hello");
	});
});
