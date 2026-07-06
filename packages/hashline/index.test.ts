import { describe, it, expect } from "vitest";
import { lineHash, parseAnchor, enhanceWithHashes } from "./index.ts";

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
