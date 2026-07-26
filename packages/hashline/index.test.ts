import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import hashlineExtension, { enhanceWithHashes, findOverlappingRange, lineHash, parseAnchor, splitReplacementContent } from "./index.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-oh-my-hashline-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function getHashlineEditTool(): any {
	let tool: any;
	hashlineExtension({
		registerTool(candidate: any) {
			if (candidate.name === "hashline_edit") tool = candidate;
		},
		on() {},
	} as any);
	return tool;
}

describe("lineHash", () => {
  it("returns 3-char uppercase base36", () => {
    const h = lineHash("hello world");
    expect(h).toMatch(/^[0-9A-Z]{3}$/);
  });

  it("is deterministic", () => {
    expect(lineHash("foo bar")).toBe(lineHash("foo bar"));
  });

  it("different lines → different hashes (usually)", () => {
    const a = lineHash("function hello() {");
    const b = lineHash("function goodbye() {");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    expect(lineHash("")).toMatch(/^[0-9A-Z]{3}$/);
  });

  it("handles unicode", () => {
    expect(lineHash("你好世界")).toMatch(/^[0-9A-Z]{3}$/);
  });
});

describe("parseAnchor", () => {
  it("parses valid anchor", () => {
    expect(parseAnchor("11#ABC")).toEqual({ line: 11, hash: "ABC" });
  });

  it("parses single digit line", () => {
    expect(parseAnchor("1#A3F")).toEqual({ line: 1, hash: "A3F" });
  });

  it("throws on missing #", () => {
    expect(() => parseAnchor("11ABC")).toThrow(/Invalid anchor/);
  });

  it("throws on lowercase hash", () => {
    expect(() => parseAnchor("11#abc")).toThrow(/Invalid anchor/);
  });

  it("throws on empty string", () => {
    expect(() => parseAnchor("")).toThrow(/Invalid anchor/);
  });

  it("throws on letter prefix", () => {
    expect(() => parseAnchor("ab#ABC")).toThrow(/Invalid anchor/);
  });
});

describe("edit helpers", () => {
	it("treats an empty replacement as a deletion", () => {
		expect(splitReplacementContent("")).toEqual([]);
		expect(splitReplacementContent("first\nsecond")).toEqual(["first", "second"]);
	});

	it("detects overlapping edit ranges before applying them", () => {
		expect(findOverlappingRange([{ start: 1, end: 2 }, { start: 2, end: 3 }])).toEqual({ start: 2, end: 3 });
		expect(findOverlappingRange([{ start: 4, end: 5 }, { start: 1, end: 3 }])).toBeNull();
	});
});

describe("hashline_edit", () => {
	it("deletes the selected line when replacement content is empty", async () => {
		const path = join(tmpDir, "sample.txt");
		writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
		const tool = getHashlineEditTool();

		const result = await tool.execute("call", {
			path: "sample.txt",
			edits: [{ startAnchor: `2#${lineHash("beta")}`, newContent: "" }],
		}, undefined, undefined, { cwd: tmpDir });

		expect(result.isError).not.toBe(true);
		expect(readFileSync(path, "utf8")).toBe("alpha\ngamma");
	});

	it("rejects overlapping edits before changing the file", async () => {
		const path = join(tmpDir, "sample.txt");
		writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
		const tool = getHashlineEditTool();

		const result = await tool.execute("call", {
			path: "sample.txt",
			edits: [
				{ startAnchor: `1#${lineHash("alpha")}`, endAnchor: `2#${lineHash("beta")}`, newContent: "first" },
				{ startAnchor: `2#${lineHash("beta")}`, newContent: "second" },
			],
		}, undefined, undefined, { cwd: tmpDir });

		expect(result.isError).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\ngamma");
	});
});

describe("enhanceWithHashes", () => {
  it("adds LINE#HASH| prefix to each line", () => {
    const result = enhanceWithHashes("hello\nworld", 1);
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^1#[0-9A-Z]{3}\| hello$/);
    expect(lines[1]).toMatch(/^2#[0-9A-Z]{3}\| world$/);
  });

  it("respects startLine offset", () => {
    const result = enhanceWithHashes("foo", 10);
    expect(result).toMatch(/^10#[0-9A-Z]{3}\| foo$/);
  });

  it("handles empty text", () => {
    const result = enhanceWithHashes("", 1);
    expect(result).toMatch(/^1#[0-9A-Z]{3}\| $/);
  });

  it("preserves truncation notice", () => {
    const text = "line one\n\n[Showing lines 1-1 of 10]";
    const result = enhanceWithHashes(text, 1);
    expect(result).toContain("[Showing lines 1-1 of 10]");
    expect(result).toContain("1#");
    expect(result).toContain("line one");
  });

  it("preserves 'more lines' notice", () => {
    const text = "line one\n\n[5 more lines in file]";
    const result = enhanceWithHashes(text, 1);
    expect(result).toContain("[5 more lines in file]");
  });

  it("preserves 'Line N is' notice", () => {
    const text = "line one\n\n[Line 5 is empty]";
    const result = enhanceWithHashes(text, 1);
    expect(result).toContain("[Line 5 is empty]");
  });
});
