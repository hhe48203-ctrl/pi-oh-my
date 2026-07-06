import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDirectoryAgentsMd, formatAgentsMdBlock } from "./index.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-oh-my-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findDirectoryAgentsMd", () => {
  it("finds AGENTS.md", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Rules");
    expect(findDirectoryAgentsMd(tmpDir)).toBe(join(tmpDir, "AGENTS.md"));
  });

  it("finds CLAUDE.md", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Rules");
    expect(findDirectoryAgentsMd(tmpDir)).toBe(join(tmpDir, "CLAUDE.md"));
  });

  it("finds AGENTS.MD (uppercase ext)", () => {
    // On case-insensitive filesystems (macOS default), AGENTS.MD == AGENTS.md.
    // Use a temp subdir to avoid collision, verify the filename list includes uppercase variant.
    const subDir = join(tmpDir, "sub");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "AGENTS.MD"), "# Rules");
    const found = findDirectoryAgentsMd(subDir);
    expect(found).not.toBeNull();
    // Assert the found path ends with either casing (FS-dependent)
    expect(found!.toLowerCase()).toBe(join(subDir, "agents.md").toLowerCase());
  });

  it("returns null when no agents file exists", () => {
    expect(findDirectoryAgentsMd(tmpDir)).toBeNull();
  });

  it("prefers AGENTS.md over CLAUDE.md (order priority)", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Rules");
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Claude Rules");
    expect(findDirectoryAgentsMd(tmpDir)).toBe(join(tmpDir, "AGENTS.md"));
  });

  it("does not search subdirectories", () => {
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "AGENTS.md"), "# Rules");
    expect(findDirectoryAgentsMd(tmpDir)).toBeNull();
  });
});

describe("formatAgentsMdBlock", () => {
  it("wraps content with directory context header", async () => {
    const filePath = join(tmpDir, "AGENTS.md");
    writeFileSync(filePath, "# Auth Rules\nUse OAuth2.");
    const block = await formatAgentsMdBlock(filePath);
    expect(block).toContain("[Directory Context:");
    expect(block).toContain(filePath);
    expect(block).toContain("# Auth Rules");
    expect(block).toContain("Use OAuth2.");
  });

  it("returns null for non-existent file", async () => {
    const block = await formatAgentsMdBlock(join(tmpDir, "nonexistent.md"));
    expect(block).toBeNull();
  });

  it("truncates content exceeding 8000 chars", async () => {
    const filePath = join(tmpDir, "AGENTS.md");
    const longContent = "x".repeat(10000);
    writeFileSync(filePath, longContent);
    const block = await formatAgentsMdBlock(filePath);
    expect(block).toBeTruthy();
    expect(block!.length).toBeLessThan(10000 + 200); // truncated + notice
    expect(block!).toContain("truncated");
  });

  it("does not truncate short content", async () => {
    const filePath = join(tmpDir, "AGENTS.md");
    writeFileSync(filePath, "short");
    const block = await formatAgentsMdBlock(filePath);
    expect(block).not.toContain("truncated");
  });
});
