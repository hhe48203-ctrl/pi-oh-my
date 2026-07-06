import { join } from "node:path";
import { existsSync } from "node:fs";

const AGENTS_FILENAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** Max chars of AGENTS.md to inject (prevents context bloat). */
const MAX_AGENTS_MD_CHARS = 8000;

/**
 * Find an AGENTS.md (or CLAUDE.md) in the given directory.
 * Returns the absolute path or null.
 */
export function findDirectoryAgentsMd(dir: string): string | null {
	for (const filename of AGENTS_FILENAMES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			return filePath;
		}
	}
	return null;
}

/**
 * Read and format an AGENTS.md for injection after read output.
 * Returns null if the file can't be read.
 */
export async function formatAgentsMdBlock(
	agentsMdPath: string,
): Promise<string | null> {
	const { readFile } = await import("node:fs/promises");
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

/**
 * In-memory cache of injected AGENTS.md paths per session.
 * Prevents duplicate injection when the agent reads multiple files
 * in the same directory. Cleared on compaction and shutdown.
 */
export class InjectedPathsCache {
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

	/** Clear cache for a specific session (used on compaction). */
	clearSession(sessionFile: string | undefined): void {
		this.map.delete(this.getKey(sessionFile));
	}

	/** Clear all sessions (used on shutdown). */
	clear(): void {
		this.map.clear();
	}
}
