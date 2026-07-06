import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_FILENAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_AGENTS_MD_CHARS = 8000;

function findDirectoryAgentsMd(dir: string): string | null {
	for (const filename of AGENTS_FILENAMES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) return filePath;
	}
	return null;
}

async function formatAgentsMdBlock(agentsMdPath: string): Promise<string | null> {
	try {
		const content = await readFile(agentsMdPath, "utf-8");
		const truncated =
			content.length > MAX_AGENTS_MD_CHARS
				? content.slice(0, MAX_AGENTS_MD_CHARS) +
					`\n\n[Note: Content was truncated to save context window space. Read the full file directly: ${agentsMdPath}]`
				: content;
		return `\n\n[Directory Context: ${agentsMdPath}]\n${truncated}`;
	} catch {
		return null;
	}
}

class InjectedPathsCache {
	private map = new Map<string, Set<string>>();
	private getKey(sessionFile: string | undefined): string {
		return sessionFile ?? "ephemeral";
	}
	has(sessionFile: string | undefined, agentsMdPath: string): boolean {
		return this.map.get(this.getKey(sessionFile))?.has(agentsMdPath) ?? false;
	}
	add(sessionFile: string | undefined, agentsMdPath: string): void {
		const key = this.getKey(sessionFile);
		let set = this.map.get(key);
		if (!set) {
			set = new Set();
			this.map.set(key, set);
		}
		set.add(agentsMdPath);
	}
	clearSession(sessionFile: string | undefined): void {
		this.map.delete(this.getKey(sessionFile));
	}
	clear(): void {
		this.map.clear();
	}
}

const injectedCache = new InjectedPathsCache();

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;

		const textPart = event.content.find(
			(c): c is { type: "text"; text: string } => c.type === "text",
		);
		if (!textPart) return;

		const input = event.input as { path?: string };
		if (!input.path) return;

		try {
			const absolutePath = resolve(ctx.cwd, input.path);
			const dir = dirname(absolutePath);
			const agentsMdPath = findDirectoryAgentsMd(dir);

			if (agentsMdPath) {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!injectedCache.has(sessionFile, agentsMdPath)) {
					const block = await formatAgentsMdBlock(agentsMdPath);
					if (block) {
						const newText = textPart.text + block;
						injectedCache.add(sessionFile, agentsMdPath);
						const newContent = event.content.map((c) => {
							if (c.type === "text") return { type: "text" as const, text: newText };
							return c;
						});
						return { content: newContent };
					}
				}
			}
		} catch {}
	});

	pi.on("session_compact", async (_event, ctx) => {
		injectedCache.clearSession(ctx.sessionManager.getSessionFile());
	});

	pi.on("session_shutdown", async () => {
		injectedCache.clear();
	});
}
