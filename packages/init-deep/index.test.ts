import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkTree, generateTemplate } from "./index.ts";
import type { DirEntry } from "./index.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-oh-my-initdeep-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("walkTree", () => {
  it("finds source files in root", () => {
    writeFileSync(join(tmpDir, "foo.ts"), "export {}");
    writeFileSync(join(tmpDir, "bar.py"), "pass");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(1);
    expect(entries[0].sourceFiles).toContain("foo.ts");
    expect(entries[0].sourceFiles).toContain("bar.py");
  });

  it("finds source files in subdirectories", () => {
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "index.ts"), "export {}");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(1);
    expect(entries[0].relativePath).toBe("src");
    expect(entries[0].sourceFiles).toContain("index.ts");
  });

  it("excludes node_modules", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "pkg.ts"), "export {}");
    writeFileSync(join(tmpDir, "app.ts"), "export {}");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(1);
    expect(entries[0].sourceFiles).toContain("app.ts");
    expect(entries[0].sourceFiles).not.toContain("pkg.ts");
  });

  it("excludes .git directory", () => {
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, ".git", "config.ts"), "export {}");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(0);
  });

  it("respects maxDepth", () => {
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "a", "b"), { recursive: true });
    mkdirSync(join(tmpDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tmpDir, "a", "shallow.ts"), "export {}");
    writeFileSync(join(tmpDir, "a", "b", "mid.ts"), "export {}");
    writeFileSync(join(tmpDir, "a", "b", "c", "deep.ts"), "export {}");
    // maxDepth=3: all three levels visited (a@1, b@2, c@3)
    expect(walkTree(tmpDir, 3).length).toBe(3);
    // maxDepth=2: a@1 and b@2 visited, c@3 skipped
    expect(walkTree(tmpDir, 2).length).toBe(2);
    // maxDepth=1: only a@1 visited
    expect(walkTree(tmpDir, 1).length).toBe(1);
  });

  it("ignores non-source files", () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Hello");
    writeFileSync(join(tmpDir, "data.json"), "{}");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(0);
  });

  it("skips directories with no source files", () => {
    mkdirSync(join(tmpDir, "empty"));
    writeFileSync(join(tmpDir, "empty", "readme.md"), "# Hello");
    writeFileSync(join(tmpDir, "main.ts"), "export {}");
    const entries = walkTree(tmpDir, 3);
    expect(entries.length).toBe(1);
    expect(entries[0].sourceFiles).toContain("main.ts");
  });
});

describe("generateTemplate", () => {
  it("generates AGENTS.md with directory name", () => {
    const dir: DirEntry = {
      path: "/fake/src/auth",
      relativePath: "src/auth",
      depth: 1,
      sourceFiles: ["login.ts", "logout.ts"],
      subdirs: [],
    };
    const template = generateTemplate(dir, "");
    expect(template).toContain("src/auth");
    expect(template).toContain("login.ts");
    expect(template).toContain("logout.ts");
  });

  it("uses 'Project Root' for root directory", () => {
    const dir: DirEntry = {
      path: "/fake",
      relativePath: ".",
      depth: 0,
      sourceFiles: ["index.ts"],
      subdirs: [],
    };
    const template = generateTemplate(dir, "");
    expect(template).toContain("Project Root");
  });

  it("extracts dependencies from context", () => {
    const dir: DirEntry = {
      path: "/fake",
      relativePath: ".",
      depth: 0,
      sourceFiles: ["index.ts"],
      subdirs: [],
    };
    const context = "dependencies: express, lodash";
    const template = generateTemplate(dir, context);
    expect(template).toContain("express, lodash");
  });
});
