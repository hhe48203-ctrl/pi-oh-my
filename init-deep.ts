import { join, relative } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const EXCLUDE_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache",
	".turbo", "coverage", ".nyc_output", ".pi", ".claude", ".cursor",
	".codex", ".opencode", ".omo", "__pycache__", ".pytest_cache",
	".mypy_cache", "venv", ".venv", "env", ".env", "target", "bin", "obj",
	".gradle", ".mvn", ".idea", ".vscode", ".DS_Store", "tmp", "temp",
]);

const SOURCE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
	".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php",
	".c", ".cpp", ".cc", ".h", ".hpp", ".cs", ".scala", ".clj",
	".ex", ".exs", ".erl", ".hs", ".ml", ".fs", ".fsx", ".dart",
	".lua", ".r", ".jl", ".zig", ".nim", ".v", ".d",
]);

const MAX_DEPTH = 3;
const MAX_FILES_PER_DIR = 20;
const MAX_FILE_PREVIEW_LINES = 15;
const MAX_FILE_PREVIEW_CHARS = 500;

interface DirEntry {
	path: string;
	relativePath: string;
	depth: number;
	sourceFiles: string[];
	subdirs: string[];
}

function walkTree(root: string, maxDepth: number): DirEntry[] {
	const results: DirEntry[] = [];

	function walk(dir: string, depth: number) {
		if (depth > maxDepth) return;

		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		} catch {
			return;
		}

		const sourceFiles: string[] = [];
		const subdirs: string[] = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!EXCLUDE_DIRS.has(entry.name)) {
					subdirs.push(entry.name);
				}
			} else if (entry.isFile()) {
				const ext = entry.name.slice(entry.name.lastIndexOf("."));
				if (SOURCE_EXTENSIONS.has(ext)) {
					sourceFiles.push(entry.name);
				}
			}
		}

		if (sourceFiles.length > 0) {
			results.push({
				path: dir,
				relativePath: relative(root, dir) || ".",
				depth,
				sourceFiles: sourceFiles.slice(0, MAX_FILES_PER_DIR),
				subdirs,
			});
		}

		for (const sub of subdirs) {
			walk(join(dir, sub), depth + 1);
		}
	}

	walk(root, 0);
	return results;
}

function gatherContext(dir: string, sourceFiles: string[]): string {
	const parts: string[] = [];

	// package.json
	const pkgPath = join(dir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			parts.push("package.json:");
			if (pkg.name) parts.push(`  name: ${pkg.name}`);
			if (pkg.description) parts.push(`  description: ${pkg.description}`);
			if (pkg.dependencies) parts.push(`  dependencies: ${Object.keys(pkg.dependencies).slice(0, 15).join(", ")}`);
			if (pkg.scripts) parts.push(`  scripts: ${Object.keys(pkg.scripts).slice(0, 10).join(", ")}`);
		} catch {}
	}

	// Key file previews
	const keyFiles = sourceFiles
		.filter(f => /^(index|main|mod|lib|app|server|client|handler|router|config)\./i.test(f))
		.slice(0, 3);

	for (const file of keyFiles) {
		try {
			const content = readFileSync(join(dir, file), "utf-8");
			const lines = content.split("\n").slice(0, MAX_FILE_PREVIEW_LINES);
			const preview = lines.join("\n").slice(0, MAX_FILE_PREVIEW_CHARS);
			parts.push(`\n--- ${file} (first ${MAX_FILE_PREVIEW_LINES} lines) ---\n${preview}`);
		} catch {}
	}

	return parts.join("\n");
}

function buildPrompt(dir: DirEntry, context: string): string {
	const dirName = dir.relativePath === "." ? "project root" : dir.relativePath;
	return `You are generating an AGENTS.md file for a code directory. Analyze the following information and write a concise AGENTS.md that helps an AI coding agent understand this directory.

Directory: ${dirName}
Files: ${dir.sourceFiles.join(", ")}
Subdirectories: ${dir.subdirs.length > 0 ? dir.subdirs.slice(0, 10).join(", ") : "(none)"}

${context}

Write an AGENTS.md file in markdown with these sections (keep under 40 lines total):
1. \`# ${dirName}\`
2. \`## Purpose\` — 1-2 sentences describing what this directory does
3. \`## Key Files\` — bullet list with one-line description of important files
4. \`## Conventions\` — patterns or rules visible in the code (naming, structure, etc.)
5. \`## Dependencies\` — external packages or other directories this depends on (if any)

Output ONLY the AGENTS.md content, no explanations or code fences.`;
}

async function callLlm(
	ctx: ExtensionCommandContext,
	prompt: string,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;

	let apiKey: string | undefined;
	let headers: Record<string, string> | undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) {
			apiKey = auth.apiKey;
			headers = auth.headers;
		}
	} catch {}
	if (!apiKey) return null;

	try {
		const { complete } = await import("@earendil-works/pi-ai/compat");
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, headers, signal: ctx.signal },
		);

		const parts = Array.isArray(response.content) ? response.content : [];
		return parts
			.map((p) => {
				const part = p as Record<string, unknown>;
				return typeof part.text === "string" ? part.text : "";
			})
			.join("")
			.trim();
	} catch {
		return null;
	}
}

function generateTemplate(dir: DirEntry, context: string): string {
	const dirName = dir.relativePath === "." ? "Project Root" : dir.relativePath;
	const fileList = dir.sourceFiles.map(f => `- \`${f}\``).join("\n");

	let deps = "";
	const pkgMatch = context.match(/dependencies:\s*(.+)/);
	if (pkgMatch) {
		deps = `\n\n## Dependencies\n${pkgMatch[1]}`;
	}

	return `# ${dirName}

## Purpose
TODO: Describe the purpose of this directory.

## Key Files
${fileList}

## Conventions
TODO: Document any conventions used in this directory.${deps}
`;
}

export function registerInitDeepCommand(pi: ExtensionAPI): void {
	pi.registerCommand("init-deep", {
		description: "Auto-generate hierarchical AGENTS.md files throughout your project",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const root = ctx.cwd;

			// Parse args for depth
			const depthArg = args.match(/--depth[=\s]+(\d+)/);
			const maxDepth = depthArg ? parseInt(depthArg[1]!, 10) : MAX_DEPTH;

			if (!ctx.hasUI) {
				return;
			}

			const ok = await ctx.ui.confirm(
				"Generate AGENTS.md files?",
				`Walk ${root} (depth ${maxDepth}) and generate AGENTS.md in each source directory. Existing files will be skipped.`,
			);
			if (!ok) return;

			ctx.ui.setStatus("init-deep", "Scanning project...");
			const dirs = walkTree(root, maxDepth);

			if (dirs.length === 0) {
				ctx.ui.notify("No source directories found.", "info");
				ctx.ui.setStatus("init-deep", undefined);
				return;
			}

			let generated = 0;
			let skipped = 0;
			let failed = 0;

			for (const dir of dirs) {
				const agentsMdPath = join(dir.path, "AGENTS.md");

				// Skip if AGENTS.md already exists
				if (existsSync(agentsMdPath)) {
					skipped++;
					continue;
				}

				ctx.ui.setStatus(
					"init-deep",
					`Generating ${dir.relativePath}/AGENTS.md (${generated + skipped + failed + 1}/${dirs.length})...`,
				);

				const context = gatherContext(dir.path, dir.sourceFiles);
				const prompt = buildPrompt(dir, context);

				// Try LLM first, fall back to template
				let content = await callLlm(ctx, prompt);
				if (!content) {
					content = generateTemplate(dir, context);
				}

				try {
					writeFileSync(agentsMdPath, content + "\n", "utf-8");
					generated++;
				} catch {
					failed++;
				}
			}

			ctx.ui.setStatus("init-deep", undefined);
			ctx.ui.notify(
				`Done: ${generated} generated, ${skipped} skipped, ${failed} failed.`,
				generated > 0 ? "info" : "warning",
			);
		},
	});
}
